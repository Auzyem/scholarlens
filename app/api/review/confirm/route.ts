import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { runDeepReviewStage } from '@/lib/ai/pipeline'
import { checkReviewLimit } from '@/lib/plan/gates'
import { reserveReviewCredit } from '@/lib/plan/ledger'
import type { ReviewerPersona } from '@/lib/types'

export const maxDuration = 300

const PERSONAS: ReviewerPersona[] = [
  'biomedical_rct', 'social_science_quant', 'social_science_qual',
  'cs_systems', 'cs_ml_theory', 'economics_theory', 'humanities_interpretive',
  'environmental_science', 'engineering_applied', 'education_research',
]

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { sessionId, field, subfield, persona } = body as {
    sessionId?: string; field?: string; subfield?: string; persona?: string
  }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  if (persona && !PERSONAS.includes(persona as ReviewerPersona)) {
    return NextResponse.json({ error: 'invalid persona' }, { status: 400 })
  }

  // RLS: only returns the row if the session belongs to the user.
  const { data: session, error } = await supabase
    .from('review_sessions')
    .select('id, status, drafts(manuscript_id)')
    .eq('id', sessionId)
    .single()

  if (error || !session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Atomically claim the confirmation: 'awaiting_confirmation' -> 'reviewing' in
  // one conditional update. A read-then-act status check would not hold here —
  // the status only leaves 'awaiting_confirmation' inside runDeepReviewStage,
  // which is launched detached after this response returns, so two concurrent
  // requests (double-click, multi-tab) would both pass the check and both
  // reserve a credit, charging one review twice. Letting the database decide the
  // winner means the loser matches zero rows and gets a 409 having reserved
  // nothing. 'reviewing' is the right target because runDeepReviewStage sets
  // exactly that as its first action, so its own write is a harmless re-write.
  const { data: claimed, error: claimError } = await supabase
    .from('review_sessions')
    .update({ status: 'reviewing' })
    .eq('id', sessionId)
    .eq('status', 'awaiting_confirmation')
    .select('id')

  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 })
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: 'This review has already been confirmed' }, { status: 409 })
  }

  // The credit was handed back when the pipeline parked here, so resuming needs
  // an available slot again — the user may have spent their allowance elsewhere
  // while this sat waiting.
  //
  // Claiming before reserving is deliberate: the loser of the race never gets
  // this far, so there is no reservation to roll back. The cost is that a quota
  // rejection below leaves the session at 'reviewing' with no work running — and
  // that now includes a rejection from the reservation itself, not just from the
  // check. Both are fine for the same reason: 'reviewing' is in
  // REAPABLE_MAIN_STATUSES, so the stuck-review reaper fails it properly within
  // 10 minutes. That is not a leak. The reverse order would be worse: it can
  // write a reservation for a session that stays parked forever, because
  // 'awaiting_confirmation' is deliberately never reaped.
  //
  // As in start, the check supplies the wording and the reservation supplies the
  // enforcement.
  const planLimit = await checkReviewLimit(user.id)
  const overLimit = () => {
    const planName = planLimit.plan[0].toUpperCase() + planLimit.plan.slice(1)
    return NextResponse.json(
      {
        error: `Monthly review limit reached (${planLimit.used}/${planLimit.limit} on the ${planName} plan)`,
        upgradeUrl: '/billing',
      },
      { status: 403 }
    )
  }
  if (!planLimit.allowed) return overLimit()

  const reservation = await reserveReviewCredit({
    userId: user.id,
    windowStart: planLimit.windowStart,
    limit: planLimit.limit,
    sessionId,
  })
  // Lost the race for the last credit. `reason: 'error'` deliberately falls
  // through unreserved and already reported — under-billing beats refusing a
  // review the user is entitled to.
  if (!reservation.ok && reservation.reason === 'limit') return overLimit()

  const manuscriptId = (session.drafts as unknown as { manuscript_id: string } | null)?.manuscript_id

  if (manuscriptId && (field || subfield)) {
    const update: Record<string, string> = {}
    if (field) update.field = field
    if (subfield) update.subfield = subfield
    await supabase.from('manuscripts').update(update).eq('id', manuscriptId)
  }
  if (persona) {
    await supabase.from('review_sessions').update({ reviewer_persona: persona }).eq('id', sessionId)
  }

  // Resume into the deep review, detached from the response (same pattern as start).
  const pipeline = runDeepReviewStage(sessionId)
  pipeline.catch((e) => console.error('[deep review stage] failed:', e))
  try {
    waitUntil(pipeline)
  } catch {
    // Non-Vercel runtime: the floating promise continues on its own.
  }

  return NextResponse.json({ ok: true })
}
