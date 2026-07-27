import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAuth } from '@/lib/apiKeys/middleware'
import { runReviewPipeline } from '@/lib/ai/pipeline'
import { RATE_LIMITS, ACTIVE_REVIEW_STATUSES, hourAgoIso } from '@/lib/rateLimit'
import { checkReviewLimit } from '@/lib/plan/gates'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
  // Accepts either the session cookie (browser) or an API key with review:write.
  const auth = await resolveAuth(request, ['review:write'])
  if (auth instanceof NextResponse) return auth
  const { userId, viaApiKey } = auth
  const supabase = viaApiKey ? createAdminClient() : createClient()

  const { draftId, mode = 'standard' } = await request.json()
  if (!draftId) return NextResponse.json({ error: 'draftId required' }, { status: 400 })

  // API-key path bypasses RLS — resolve the caller's draft ids and verify the
  // target draft belongs to them before doing anything else.
  let userDraftIds: string[] | null = null
  if (viaApiKey) {
    const { data: mans } = await supabase.from('manuscripts').select('id').eq('user_id', userId)
    const manIds = (mans ?? []).map((m) => m.id)
    const { data: drafts } = manIds.length
      ? await supabase.from('drafts').select('id').in('manuscript_id', manIds)
      : { data: [] as { id: string }[] }
    userDraftIds = (drafts ?? []).map((d) => d.id)
    if (!userDraftIds.includes(draftId)) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 403 })
    }
  }

  // Rate limits (cookie path: RLS scopes the counts; API path: scope by draft ids).
  // 1) only one actively-running review at a time
  let activeQuery = supabase
    .from('review_sessions')
    .select('id')
    .in('status', ACTIVE_REVIEW_STATUSES as unknown as string[])
    .limit(1)
  if (viaApiKey) activeQuery = activeQuery.in('draft_id', userDraftIds ?? [])
  const { data: active } = await activeQuery
  if (active && active.length > 0) {
    return NextResponse.json(
      { error: 'You already have a review in progress. Please wait for it to finish.' },
      { status: 429 }
    )
  }
  // 2) a rolling hourly cap
  let countQuery = supabase
    .from('review_sessions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', hourAgoIso())
  if (viaApiKey) countQuery = countQuery.in('draft_id', userDraftIds ?? [])
  const { count } = await countQuery
  if ((count ?? 0) >= RATE_LIMITS.reviewsPerHour) {
    return NextResponse.json(
      { error: 'Hourly review limit reached. Please try again later.' },
      { status: 429 }
    )
  }

  // 3) the plan's monthly review cap (business limit, distinct from the hourly abuse cap above)
  const planLimit = await checkReviewLimit(userId)
  if (!planLimit.allowed) {
    const planName = planLimit.plan[0].toUpperCase() + planLimit.plan.slice(1)
    return NextResponse.json(
      { error: `Monthly review limit reached (${planLimit.used}/${planLimit.limit} on the ${planName} plan)`, upgradeUrl: '/billing' },
      { status: 403 }
    )
  }

  const { data: session, error } = await supabase
    .from('review_sessions')
    .insert({ draft_id: draftId, mode, status: 'queued' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!session?.id) {
    return NextResponse.json({ error: 'Failed to create review session' }, { status: 500 })
  }

  // Run the pipeline detached from the response lifecycle. The promise starts
  // executing immediately; waitUntil keeps the serverless function alive on
  // Vercel until it settles. Outside the Vercel runtime (e.g. `next dev`),
  // waitUntil can throw — the pipeline is already running, so we swallow it.
  const pipeline = runReviewPipeline(session.id)
  pipeline.catch((e) => console.error('[review pipeline] failed:', e))
  try {
    waitUntil(pipeline)
  } catch {
    // Non-Vercel runtime: the floating promise above continues on its own.
  }

  return NextResponse.json({ sessionId: session.id })
  } catch (error: unknown) {
    console.error('[api/review/start] error:', error)
    const message = error instanceof Error ? error.message : 'Failed to start review'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
