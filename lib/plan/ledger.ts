import { createAdminClient } from '@/lib/supabase/admin'
import { quotaWindowStart } from '@/lib/plan/period'
import { reportError, reportWarning } from '@/lib/monitoring/sentry'

/**
 * The durable usage ledger.
 *
 * This is the only module that reads or writes `usage_events`. Usage is
 * recorded here rather than derived from `review_sessions`, because those rows
 * cascade away when a manuscript is deleted and took the user's spent
 * allowance with them.
 *
 * Counting rule, applied identically to both kinds:
 *   used = rows in state 'reserved' or 'consumed'.  'released' never counts.
 *
 * A reserved row counts because the work is in flight; a released row does not
 * because the work produced nothing.
 */

export type UsageKind = 'review' | 'manuscript_slot'

/** States that occupy an allowance. Exported so callers cannot drift from it. */
export const OCCUPYING_STATES = ['reserved', 'consumed'] as const

export interface QuotaContext {
  planId: string
  plan: Record<string, unknown> | null
  windowStart: Date
}

/**
 * Resolve the caller's plan and the instant their current quota window began.
 *
 * Queries `subscriptions` and `profiles` exactly once each, which is what keeps
 * this testable against the one-response-per-table mock.
 */
export async function resolveQuotaContext(userId: string, now = new Date()): Promise<QuotaContext> {
  const admin = createAdminClient()

  const [{ data: sub, error: subError }, { data: profile, error: profileError }] =
    await Promise.all([
      admin
        .from('subscriptions')
        .select('plan_id, current_period_start, plans(*)')
        .eq('user_id', userId)
        .maybeSingle(),
      admin.from('profiles').select('created_at').eq('id', userId).maybeSingle(),
    ])

  // Either failure degrades the window silently — an unreadable subscription
  // looks like the free plan, an unreadable profile looks like an account with
  // no creation date. Both now fail safe below, but a quota resolved from a
  // failed read is still wrong for the user in front of it, so it must be seen.
  if (subError) reportError(subError, { userId, stage: 'quota context: subscriptions' })
  if (profileError) reportError(profileError, { userId, stage: 'quota context: profiles' })

  const plan = (sub?.plans as unknown as Record<string, unknown> | null) ?? null

  // Absent flag means a plans row predating migration 020 — those all reset.
  const resets = plan ? plan.quota_resets !== false : true

  return {
    planId: (sub?.plan_id as string | undefined) ?? 'free',
    plan,
    windowStart: quotaWindowStart(
      (sub?.current_period_start as string | null | undefined) ?? null,
      now,
      { resets, accountCreatedAt: (profile?.created_at as string | undefined) ?? null },
    ),
  }
}

/** How much of `kind` the user has occupied since `windowStart`. */
export async function countUsage(
  userId: string,
  kind: UsageKind,
  windowStart: Date,
): Promise<number> {
  const admin = createAdminClient()
  const { count } = await admin
    .from('usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .in('state', OCCUPYING_STATES as unknown as string[])
    .gte('window_start', windowStart.toISOString())
  return count ?? 0
}

/**
 * Which of the user's manuscripts have had their slot charged.
 *
 * Returns two sets from a single query:
 *   - `inWindow`: charged during the current quota window — these count now.
 *   - `ever`: charged at any time — these are not "live but uncharged", so a
 *     manuscript reviewed in a previous window costs nothing this window.
 *
 * One query, because per-user slot volumes are small (bounded by the plan's
 * manuscript cap) and a second round trip buys nothing.
 */
export async function chargedSlotManuscriptIds(
  userId: string,
  windowStart: Date,
): Promise<{ inWindow: Set<string>; ever: Set<string> }> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('usage_events')
    .select('manuscript_id, window_start')
    .eq('user_id', userId)
    .eq('kind', 'manuscript_slot')
    .in('state', OCCUPYING_STATES as unknown as string[])

  const inWindow = new Set<string>()
  const ever = new Set<string>()
  for (const row of (data ?? []) as { manuscript_id: string | null; window_start: string }[]) {
    if (!row.manuscript_id) continue
    ever.add(row.manuscript_id)
    if (new Date(row.window_start).getTime() >= windowStart.getTime()) {
      inWindow.add(row.manuscript_id)
    }
  }
  return { inWindow, ever }
}

/**
 * Hold a review credit before the pipeline starts.
 *
 * The hold is what prevents an overrun during the minutes a review runs. The
 * caller must have already confirmed availability via checkReviewLimit.
 */
export async function insertReservation(
  userId: string,
  windowStart: Date,
  sessionId: string | null,
): Promise<string | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('usage_events')
    .insert({
      user_id: userId,
      kind: 'review',
      state: 'reserved',
      review_session_id: sessionId,
      window_start: windowStart.toISOString(),
    })
    .select('id')
    .single()

  // Callers that ignore the null return would run the review free and silently.
  // Under-billing is the acceptable direction, but never the invisible one.
  if (error) reportError(error, { userId, sessionId, stage: 'usage reserve' })

  return (data?.id as string | undefined) ?? null
}

/** Attach a session to a reservation made before the session row existed. */
export async function attachSessionToReservation(
  eventId: string,
  sessionId: string,
): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin
    .from('usage_events')
    .update({ review_session_id: sessionId })
    .eq('id', eventId)

  // An unattached row is unreachable: no release can find it and no commit can
  // consume it, so the credit stays reserved forever. It needs a human.
  if (error) reportError(error, { eventId, sessionId, stage: 'usage attach session' })
}

/**
 * Give the credit back. A review that produced nothing must not be charged —
 * whether it failed normally or was reaped after its process died.
 *
 * Idempotent: the state filter means a second call matches zero rows.
 */
export async function releaseReviewCredit(sessionId: string): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin
    .from('usage_events')
    .update({ state: 'released' })
    .eq('review_session_id', sessionId)
    .eq('kind', 'review')
    .eq('state', 'reserved')

  // A failed release strands the credit, and worse: a later re-reservation for
  // the same session leaves two reserved rows behind. commitReviewCredit is
  // built to survive that, but it must not happen unseen.
  if (error) reportError(error, { sessionId, stage: 'usage release' })
}

/**
 * Spend exactly one credit, and charge the manuscript's slot if this is the
 * first review it has completed.
 *
 * Also self-healing: any surplus reservations held by the same session are
 * released here, so a release that failed earlier cannot strand a credit.
 *
 * The slot insert races against the partial unique index rather than checking
 * first — a re-review is *expected* to violate it, and letting the database
 * decide removes a check-then-act race between concurrent reviews.
 *
 * Idempotent, and deliberately never throws for the already-charged case: by
 * the time this runs the user already has their review. Failing to charge
 * under-bills, which is the correct direction to fail.
 */
export async function commitReviewCredit(args: {
  sessionId: string
  userId: string
  manuscriptId: string
  windowStart: Date
}): Promise<void> {
  const admin = createAdminClient()

  // Read the reservations first rather than updating by session, because a
  // session can legitimately hold more than one: a release that failed
  // transiently (confirm/retry both re-reserve) leaves its row `reserved`, and
  // a blanket update would consume every one of them — charging a user several
  // credits for the single review they received.
  const { data: reserved, error: readError } = await admin
    .from('usage_events')
    .select('id')
    .eq('review_session_id', args.sessionId)
    .eq('kind', 'review')
    .eq('state', 'reserved')
    .order('created_at', { ascending: true })

  if (readError) {
    reportError(readError, {
      sessionId: args.sessionId,
      userId: args.userId,
      stage: 'usage commit: read reservations',
    })
  }

  const [consumeId, ...duplicates] = ((reserved ?? []) as { id: string }[]).map((r) => r.id)

  if (!consumeId) {
    // No reservation to spend. Under-billing is the acceptable direction, so
    // the review still stands and the slot below is still charged — but this
    // means a credit was never held for work that completed, so say so.
    reportWarning('review completed with no reservation to consume', {
      sessionId: args.sessionId,
      userId: args.userId,
      manuscriptId: args.manuscriptId,
    })
  } else {
    const { error: consumeError } = await admin
      .from('usage_events')
      .update({ state: 'consumed', consumed_at: new Date().toISOString() })
      .eq('id', consumeId)

    if (consumeError) {
      reportError(consumeError, {
        sessionId: args.sessionId,
        userId: args.userId,
        eventId: consumeId,
        stage: 'usage commit: consume',
      })
    }

    // Releasing the extras is what makes commit self-healing. Every duplicate
    // here is a reservation whose release failed earlier; left alone it would
    // occupy a credit for the rest of the user's quota window (forever, on a
    // non-resetting plan) for a review that has already been paid for once.
    if (duplicates.length > 0) {
      const { error: releaseError } = await admin
        .from('usage_events')
        .update({ state: 'released' })
        .in('id', duplicates)

      if (releaseError) {
        reportError(releaseError, {
          sessionId: args.sessionId,
          userId: args.userId,
          duplicateCount: duplicates.length,
          stage: 'usage commit: release duplicates',
        })
      }
    }
  }

  const { error } = await admin.from('usage_events').insert({
    user_id: args.userId,
    kind: 'manuscript_slot',
    state: 'consumed',
    manuscript_id: args.manuscriptId,
    window_start: args.windowStart.toISOString(),
    consumed_at: new Date().toISOString(),
  })

  // 23505 = unique_violation: the slot was already charged by an earlier review
  // of the same manuscript. Expected on every re-review.
  if (error && error.code !== '23505') throw error
}
