import { createAdminClient } from '@/lib/supabase/admin'
import { resolveQuotaContext, countUsage, chargedSlotManuscriptIds } from '@/lib/plan/ledger'

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

/**
 * Manuscript slot gate.
 *
 *   used = manuscripts charged in this window
 *        + live manuscripts that have never been charged
 *
 * A slot is charged when a manuscript's first review *completes*, so uploading
 * the wrong file and deleting it costs nothing. Once charged, deleting the
 * manuscript never refunds — the charge lives in the ledger, which no cascade
 * reaches. The second term keeps storage bounded without charging for it.
 */
export async function checkManuscriptLimit(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number; plan: string }> {
  if (await isSuperAdmin(userId)) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: 'super_admin' }
  }

  const { planId, plan, windowStart } = await resolveQuotaContext(userId)
  // `?? 1` would also fire on an explicit `null` (unlimited) — only default
  // when there's no plan row at all.
  const rawLimit = plan ? (plan.max_manuscripts as number | null) : 1
  if (rawLimit === null) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: planId }
  }

  const admin = createAdminClient()
  const [{ data: live }, charged] = await Promise.all([
    admin.from('manuscripts').select('id').eq('user_id', userId).eq('archived', false),
    chargedSlotManuscriptIds(userId, windowStart),
  ])

  const liveUncharged = ((live ?? []) as { id: string }[]).filter((m) => !charged.ever.has(m.id))
  const used = charged.inWindow.size + liveUncharged.length

  return { allowed: used < rawLimit, used, limit: rawLimit, plan: planId }
}

/**
 * Monthly review gate. Counts the durable ledger, never `review_sessions`.
 *
 * The old implementation walked manuscripts -> drafts -> review_sessions; every
 * link cascades on delete, so deleting a manuscript refunded the allowance.
 * Nothing here is reachable by that cascade.
 *
 * `windowStart` is returned so the caller can reserve against the same window
 * this check used, without resolving it a second time.
 */
export async function checkReviewLimit(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number; plan: string; windowStart: Date }> {
  if (await isSuperAdmin(userId)) {
    return {
      allowed: true,
      used: 0,
      limit: Number.POSITIVE_INFINITY,
      plan: 'super_admin',
      windowStart: new Date(0),
    }
  }

  const { planId, plan, windowStart } = await resolveQuotaContext(userId)
  // `?? 2` would also fire on an explicit `null` (unlimited) — only default
  // when there's no plan row at all.
  const rawLimit = plan ? (plan.max_reviews_per_month as number | null) : 2
  if (rawLimit === null) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: planId, windowStart }
  }

  const used = await countUsage(userId, 'review', windowStart)
  return { allowed: used < rawLimit, used, limit: rawLimit, plan: planId, windowStart }
}

/** Feature-flag gate: adversarial review, journal matching, PDF reports. */
export async function checkFeatureGate(
  userId: string,
  feature: PlanFeature
): Promise<{ allowed: boolean; plan: string }> {
  if (await isSuperAdmin(userId)) return { allowed: true, plan: 'super_admin' }

  const { planId, plan } = await resolveQuotaContext(userId)
  return { allowed: isFeatureAllowed(plan, feature), plan: planId }
}
