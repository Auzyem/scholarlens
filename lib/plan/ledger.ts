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
 * Counting rule:
 *   used = every 'consumed' row, plus 'reserved' rows younger than
 *          STALE_RESERVATION_MS.  'released' never counts.
 *
 * A reserved row counts because the work is in flight; a released row does not
 * because the work produced nothing. The age bound exists because "in flight"
 * has an upper limit: a reservation older than that belongs to a pipeline that
 * died without ever releasing, and without the bound its credit would be
 * occupied for the rest of the quota window — forever, on a non-resetting plan.
 *
 * Manuscript slots are exempt from the age rule because they are only ever
 * written directly as 'consumed'; there is no such thing as a stale slot.
 */

export type UsageKind = 'review' | 'manuscript_slot'

/** States that occupy an allowance. Exported so callers cannot drift from it. */
export const OCCUPYING_STATES = ['reserved', 'consumed'] as const

/**
 * How long a `reserved` row may sit before it stops occupying an allowance.
 *
 * The review routes cap at `maxDuration = 300`s and the stuck-review reaper
 * fires at 10 minutes, so a hold this old is not live work — it is a pipeline
 * that died without releasing. Ignoring it on read (rather than sweeping it on
 * a schedule) needs no cron, no writes and no locking, and it self-corrects: if
 * that review somehow does complete, commitReviewCredit consumes the row and it
 * counts again.
 */
export const STALE_RESERVATION_MS = 60 * 60 * 1000

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

  // Absent flag on a real plans row means a row predating migration 020 — those
  // all reset. No plans row at all is different: `planId` below falls back to
  // 'free', and free does NOT reset, so defaulting `resets` to true here would
  // contradict it and hand an unidentified user a fresh allowance every month.
  // That is reachable without any error — a missing subscriptions row is enough.
  const resets = plan ? plan.quota_resets !== false : false

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

/**
 * How much of `kind` the user has occupied since `windowStart`.
 *
 * The `.or()` is the staleness rule, and it must stay byte-for-byte equivalent
 * to the predicate inside `reserve_review_credit` (migration 021) — that
 * function is the authority on whether a reservation is granted, and this one
 * produces the used/limit numbers the user is shown. If they disagree, the UI
 * says "1 of 2 used" while the database refuses to reserve, or vice versa.
 * PostgREST cannot express `consumed OR (reserved AND fresh)` by chaining
 * `.eq`/`.in`, hence the raw filter string.
 */
export async function countUsage(
  userId: string,
  kind: UsageKind,
  windowStart: Date,
): Promise<number> {
  const admin = createAdminClient()
  const staleCutoffIso = new Date(Date.now() - STALE_RESERVATION_MS).toISOString()
  const { count } = await admin
    .from('usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .or(`state.eq.consumed,and(state.eq.reserved,created_at.gt.${staleCutoffIso})`)
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

export type ReservationResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'limit' | 'error' }

/**
 * Hold a review credit before the pipeline starts — atomically.
 *
 * The hold is what prevents an overrun during the minutes a review runs, but
 * the *taking* of the hold used to be an overrun of its own: checkReviewLimit
 * read and this function wrote, with nothing holding between them, so N
 * concurrent requests all read "under the limit" and all inserted. One credit
 * could buy up to the hourly abuse cap's worth of real model spend.
 *
 * So the count and the insert happen together inside `reserve_review_credit`
 * (migration 021), under a per-user advisory lock. The window and the limit are
 * still decided here in TypeScript and passed down — the function enforces
 * numbers, it does not author them.
 *
 * A `limit` refusal is authoritative and the caller must turn it into a 403;
 * checkReviewLimit stays useful only for the friendly used/limit message and
 * for short-circuiting the common case.
 */
export async function reserveReviewCredit(args: {
  userId: string
  windowStart: Date
  limit: number // Number.POSITIVE_INFINITY for unlimited
  sessionId: string | null
}): Promise<ReservationResult> {
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('reserve_review_credit', {
    p_user_id: args.userId,
    p_window_start: args.windowStart.toISOString(),
    // Unlimited is SQL null, not Infinity. JSON.stringify(Infinity) already
    // serialises to null, but relying on that leaves the contract one JSON
    // encoder away from sending something Postgres reads as 0.
    p_limit: Number.isFinite(args.limit) ? args.limit : null,
    p_session_id: args.sessionId,
    p_stale_seconds: Math.floor(STALE_RESERVATION_MS / 1000),
  })

  // Callers treat an error as "proceed unreserved", so the review runs free.
  // Under-billing is the acceptable direction, but never the invisible one.
  if (error) {
    reportError(error, { userId: args.userId, sessionId: args.sessionId, stage: 'usage reserve' })
    return { ok: false, reason: 'error' }
  }

  // Null means the function counted at or over the limit. Either the caller was
  // genuinely out of credits, or it lost the race to a concurrent request that
  // took the last one — indistinguishable from here, and the same 403 either way.
  if (data === null) return { ok: false, reason: 'limit' }

  return { ok: true, id: data as string }
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
