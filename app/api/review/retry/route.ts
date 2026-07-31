import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runReviewPipeline } from '@/lib/ai/pipeline'
import { checkReviewLimit } from '@/lib/plan/gates'

export const maxDuration = 300

/**
 * Re-run the main review pipeline for a session that failed — whether it failed
 * on its own or was reaped after its process died.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId } = await request.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  // RLS: this only returns the row if the session belongs to the caller. Doing
  // it through the cookie client is what enforces ownership before the
  // service-role work below.
  const { data: session, error } = await supabase
    .from('review_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .single()

  if (error || !session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.status !== 'failed') {
    return NextResponse.json({ error: 'Only a failed review can be retried' }, { status: 409 })
  }

  // Failed sessions no longer count toward the quota, so a retry genuinely
  // needs an available slot.
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

  // Atomically claim the retry: 'failed' -> 'queued' in one conditional update.
  // Concurrent requests (double-click, multi-tab) race here and exactly one
  // wins; the loser matches zero rows and gets a 409 instead of starting a
  // second pipeline against the same session.
  const { data: claimed, error: claimError } = await supabase
    .from('review_sessions')
    .update({
      status: 'queued',
      error_message: null,
      overall_score: null,
      verdict: null,
      strength_summary: null,
      weakness_summary: null,
      score_delta: null,
      completed_at: null,
    })
    .eq('id', sessionId)
    .eq('status', 'failed')
    .select('id')

  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 })
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: 'Review is already being retried' }, { status: 409 })
  }

  // Clear what the previous attempt wrote. scores/annotations are inserted, not
  // upserted, so a session that died after the scores insert would otherwise
  // come back with 16 score rows instead of 8. Service-role because the pipeline
  // itself runs detached without a user cookie.
  const admin = createAdminClient()
  await admin.from('scores').delete().eq('session_id', sessionId)
  await admin.from('annotations').delete().eq('session_id', sessionId)

  const pipeline = runReviewPipeline(sessionId)
  pipeline.catch((e) => console.error('[review retry pipeline] failed:', e))
  try {
    waitUntil(pipeline)
  } catch {
    // Non-Vercel runtime: the floating promise above continues on its own.
  }

  return NextResponse.json({ ok: true })
}
