import { describe, it, expect, vi } from 'vitest'

// Mock the service-role client so the real lib/supabase/admin (which imports
// 'server-only') never loads under Vitest, following the pattern in
// tests/stripePrices.test.ts. Each table gets one canned response per test —
// every gate function under test queries a given table at most once per call.
function mockAdmin(responses: Record<string, unknown>, neqCalls: [string, unknown][] = []) {
  return {
    from: vi.fn((table: string) => {
      const result = responses[table] ?? { data: null, count: 0 }
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'gte', 'in', 'order']) {
        builder[m] = vi.fn(() => builder)
      }
      // Recorded rather than merely chainable: the quota-release behaviour IS
      // the neq filter, so a test needs to assert it was applied.
      builder.neq = vi.fn((col: string, val: unknown) => {
        neqCalls.push([col, val])
        return builder
      })
      builder.single = vi.fn(async () => result)
      builder.maybeSingle = vi.fn(async () => result)
      // Postgrest query builders are thenable — awaiting the builder itself
      // (no terminal method called) resolves to the query result.
      ;(builder as unknown as PromiseLike<unknown>).then = (resolve: (v: unknown) => void) => resolve(result)
      return builder
    }),
  }
}

const h = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof mockAdmin> }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }))

import { isFeatureAllowed, checkManuscriptLimit, checkReviewLimit, checkFeatureGate } from '@/lib/plan/gates'

const notSuperAdmin = { data: [{ role: 'author' }] }
const superAdmin = { data: [{ role: 'super_admin' }] }

describe('isFeatureAllowed', () => {
  it('returns true only when the plan flag is exactly true', () => {
    expect(isFeatureAllowed({ pdf_reports: true }, 'pdf_reports')).toBe(true)
    expect(isFeatureAllowed({ pdf_reports: false }, 'pdf_reports')).toBe(false)
    expect(isFeatureAllowed({}, 'pdf_reports')).toBe(false)
    expect(isFeatureAllowed(null, 'adversarial_access')).toBe(false)
  })
})

describe('checkManuscriptLimit', () => {
  it('allows when under the cap', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'starter', plans: { max_manuscripts: 2 } } },
      manuscripts: { count: 1 },
    })
    await expect(checkManuscriptLimit('u1')).resolves.toEqual({ allowed: true, used: 1, limit: 2, plan: 'starter' })
  })

  it('blocks at the cap', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'free', plans: { max_manuscripts: 1 } } },
      manuscripts: { count: 1 },
    })
    await expect(checkManuscriptLimit('u1')).resolves.toEqual({ allowed: false, used: 1, limit: 1, plan: 'free' })
  })

  it('treats a null limit as unlimited', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'team', plans: { max_manuscripts: null } } },
      manuscripts: { count: 999 },
    })
    const result = await checkManuscriptLimit('u1')
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(Number.POSITIVE_INFINITY)
  })

  it('bypasses entirely for super_admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({ allowed: true, plan: 'super_admin' })
  })
})

describe('checkReviewLimit', () => {
  it('allows when under the monthly cap', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'starter', plans: { max_reviews_per_month: 4 } } },
      manuscripts: { data: [{ id: 'm1' }] },
      drafts: { data: [{ id: 'd1' }] },
      review_sessions: { count: 2 },
    })
    await expect(checkReviewLimit('u1')).resolves.toEqual({ allowed: true, used: 2, limit: 4, plan: 'starter' })
  })

  it('blocks at the monthly cap', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'free', plans: { max_reviews_per_month: 2 } } },
      manuscripts: { data: [{ id: 'm1' }] },
      drafts: { data: [{ id: 'd1' }] },
      review_sessions: { count: 2 },
    })
    await expect(checkReviewLimit('u1')).resolves.toEqual({ allowed: false, used: 2, limit: 2, plan: 'free' })
  })

  it('allows with zero usage when the user has no manuscripts yet', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'free', plans: { max_reviews_per_month: 2 } } },
      manuscripts: { data: [] },
    })
    await expect(checkReviewLimit('u1')).resolves.toEqual({ allowed: true, used: 0, limit: 2, plan: 'free' })
  })

  it('bypasses entirely for super_admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkReviewLimit('u1')).resolves.toMatchObject({ allowed: true, plan: 'super_admin' })
  })

  it('excludes failed sessions from the count', async () => {
    // A review that produced nothing must not consume the user's allowance —
    // whether it failed normally or was reaped after its pipeline died.
    const neqCalls: [string, unknown][] = []
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'starter', plans: { max_reviews_per_month: 4 } } },
      manuscripts: { data: [{ id: 'm1' }] },
      drafts: { data: [{ id: 'd1' }] },
      review_sessions: { count: 1 },
    }, neqCalls)

    const result = await checkReviewLimit('u1')

    expect(neqCalls).toContainEqual(['status', 'failed'])
    expect(result).toEqual({ allowed: true, used: 1, limit: 4, plan: 'starter' })
  })
})

describe('checkFeatureGate', () => {
  it('allows when the plan flag is true', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'pro', plans: { adversarial_access: true } } },
    })
    await expect(checkFeatureGate('u1', 'adversarial_access')).resolves.toEqual({ allowed: true, plan: 'pro' })
  })

  it('blocks when the plan flag is false', async () => {
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      subscriptions: { data: { plan_id: 'free', plans: { adversarial_access: false } } },
    })
    await expect(checkFeatureGate('u1', 'adversarial_access')).resolves.toEqual({ allowed: false, plan: 'free' })
  })

  it('bypasses entirely for super_admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkFeatureGate('u1', 'pdf_reports')).resolves.toEqual({ allowed: true, plan: 'super_admin' })
  })
})
