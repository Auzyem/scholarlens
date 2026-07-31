import { createAdminClient } from '@/lib/supabase/admin'
import { quotaWindowStart } from '@/lib/plan/period'

export type PlanFeature =
  | 'adversarial_access'
  | 'journal_matching'
  | 'pdf_reports'
  | 'api_access'

/** Pure predicate — unit-testable without Supabase. */
export function isFeatureAllowed(
  plan: Record<string, unknown> | null | undefined,
  feature: PlanFeature
): boolean {
  return plan?.[feature] === true
}

/**
 * True if the caller holds a role that bypasses plan gates entirely (matches
 * the existing precedent in app/api/keys/route.ts).
 */
async function isSuperAdmin(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin.from('user_roles').select('role').eq('user_id', userId)
  return (data ?? []).some((r) => r.role === 'super_admin')
}

async function getUserPlan(userId: string, admin: ReturnType<typeof createAdminClient>) {
  const { data } = await admin
    .from('subscriptions')
    .select('plan_id, current_period_start, plans(*)')
    .eq('user_id', userId)
    .single()
  return {
    planId: data?.plan_id ?? 'free',
    plan: (data?.plans as unknown as Record<string, unknown> | null) ?? null,
    periodStart: (data?.current_period_start as string | null | undefined) ?? null,
  }
}

/**
 * Manuscript count gate — counts non-archived manuscripts (archiving frees a
 * slot). Uses the admin client + explicit user_id filtering throughout so it
 * works identically for cookie-session and API-key callers.
 */
export async function checkManuscriptLimit(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number; plan: string }> {
  if (await isSuperAdmin(userId)) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: 'super_admin' }
  }

  const admin = createAdminClient()
  const { planId, plan } = await getUserPlan(userId, admin)
  // `?? 1` would also fire on an explicit `null` (unlimited) — only default
  // when there's no plan row at all.
  const rawLimit = plan ? (plan.max_manuscripts as number | null) : 1
  if (rawLimit === null) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: planId }
  }
  const limit = rawLimit

  const { count } = await admin
    .from('manuscripts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('archived', false)

  const used = count ?? 0
  return { allowed: used < limit, used, limit, plan: planId }
}

/** Monthly review-start gate. Works identically for cookie-session or API-key callers. */
export async function checkReviewLimit(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number; plan: string }> {
  if (await isSuperAdmin(userId)) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: 'super_admin' }
  }

  const admin = createAdminClient()
  const { planId, plan, periodStart } = await getUserPlan(userId, admin)
  // `?? 2` would also fire on an explicit `null` (unlimited) — only default
  // when there's no plan row at all.
  const rawLimit = plan ? (plan.max_reviews_per_month as number | null) : 2
  if (rawLimit === null) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: planId }
  }
  const limit = rawLimit

  // Two-step id resolution (supabase-js can't take a query builder in .in()).
  const { data: manuscripts } = await admin.from('manuscripts').select('id').eq('user_id', userId)
  const manuscriptIds = (manuscripts ?? []).map((m) => m.id)
  if (manuscriptIds.length === 0) return { allowed: true, used: 0, limit, plan: planId }

  const { data: drafts } = await admin.from('drafts').select('id').in('manuscript_id', manuscriptIds)
  const draftIds = (drafts ?? []).map((d) => d.id)
  if (draftIds.length === 0) return { allowed: true, used: 0, limit, plan: planId }

  // Anchored to the subscription's billing period, not the calendar month.
  const windowStart = quotaWindowStart(periodStart, new Date())

  // A failed review produced nothing, so it must not consume the user's
  // allowance — whether it failed normally or was reaped after its pipeline
  // died. The hourly abuse cap in review/start remains the backstop against
  // someone looping deliberately.
  const { count } = await admin
    .from('review_sessions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', windowStart.toISOString())
    .neq('status', 'failed')
    .in('draft_id', draftIds)

  const used = count ?? 0
  return { allowed: used < limit, used, limit, plan: planId }
}

/** Feature-flag gate: adversarial review, journal matching, PDF reports. */
export async function checkFeatureGate(
  userId: string,
  feature: PlanFeature
): Promise<{ allowed: boolean; plan: string }> {
  if (await isSuperAdmin(userId)) return { allowed: true, plan: 'super_admin' }

  const admin = createAdminClient()
  const { planId, plan } = await getUserPlan(userId, admin)
  return { allowed: isFeatureAllowed(plan, feature), plan: planId }
}
