import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { runDeepReviewStage } from '@/lib/ai/pipeline'
import { checkReviewLimit } from '@/lib/plan/gates'
import { insertReservation } from '@/lib/plan/ledger'
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
  if (session.status !== 'awaiting_confirmation') {
    return NextResponse.json({ error: 'Session is not awaiting confirmation' }, { status: 409 })
  }

  // The credit was handed back when the pipeline parked here, so resuming needs
  // an available slot again — the user may have spent their allowance elsewhere
  // while this sat waiting.
  const planLimit = await checkReviewLimit(user.id)
  if (!planLimit.allowed) {
    const planName = planLimit.plan[0].toUpperCase() + planLimit.plan.slice(1)
    return NextResponse.json(
      {
        error: `Monthly review limit reached (${planLimit.used}/${planLimit.limit} on the ${planName} plan)`,
        upgradeUrl: '/billing',
      },
      { status: 403 }
    )
  }
  await insertReservation(user.id, planLimit.windowStart, sessionId)

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
