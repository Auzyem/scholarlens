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

const ledger = vi.hoisted(() => ({
  resolveQuotaContext: vi.fn(),
  chargedSlotManuscriptIds: vi.fn(),
}))
// Only the two context helpers are stubbed. `countUsage` runs for real against
// the mocked admin client — asserting on its query is part of the point.
vi.mock('@/lib/plan/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/ledger')>()),
  resolveQuotaContext: ledger.resolveQuotaContext,
  chargedSlotManuscriptIds: ledger.chargedSlotManuscriptIds,
}))

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
  const WINDOW = '2026-07-01T00:00:00.000Z'
  const ctx = (planId: string, plan: Record<string, unknown> | null) => ({
    planId, plan, windowStart: new Date(WINDOW),
  })

  it('counts a live un-reviewed manuscript', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [{ id: 'm1' }] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('starter', { max_manuscripts: 2 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({ inWindow: new Set(), ever: new Set() })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({
      allowed: true, used: 1, limit: 2, plan: 'starter',
    })
  })

  it('still counts a reviewed manuscript after it has been deleted', async () => {
    // The manuscript row is gone. The charge is not.
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('free', { max_manuscripts: 1 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({
      inWindow: new Set(['deleted-m']), ever: new Set(['deleted-m']),
    })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({
      allowed: false, used: 1, limit: 1,
    })
  })

  it('does not double-count a manuscript that is both live and charged', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [{ id: 'm1' }] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('starter', { max_manuscripts: 5 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({
      inWindow: new Set(['m1']), ever: new Set(['m1']),
    })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({ used: 1 })
  })

  it('does not re-charge a manuscript charged in an earlier window', async () => {
    // Charged last month, still on disk: it is neither this window's charge nor
    // an uncharged live manuscript, so it costs nothing now.
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [{ id: 'old' }] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('pro', { max_manuscripts: 100 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({
      inWindow: new Set(), ever: new Set(['old']),
    })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({ used: 0 })
  })

  it('treats a null limit as unlimited', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('team', { max_manuscripts: null }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({ inWindow: new Set(), ever: new Set() })
    const result = await checkManuscriptLimit('u1')
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(Number.POSITIVE_INFINITY)
  })

  it('bypasses the gate for a super admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({ allowed: true, plan: 'super_admin' })
  })
})

describe('checkReviewLimit', () => {
  const WINDOW = '2026-07-01T00:00:00.000Z'

  // resolveQuotaContext is exercised in tests/planLedger.test.ts. Mocking it
  // here keeps each gate test to one canned response per table.
  function mockCtx(planId: string, plan: Record<string, unknown> | null) {
    return { planId, plan, windowStart: new Date(WINDOW) }
  }

  it('allows when under the cap', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 2 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('starter', { max_reviews_per_month: 4 }))
    await expect(checkReviewLimit('u1')).resolves.toEqual({
      allowed: true, used: 2, limit: 4, plan: 'starter', windowStart: new Date(WINDOW),
    })
  })

  it('blocks at the cap', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 2 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('free', { max_reviews_per_month: 2 }))
    await expect(checkReviewLimit('u1')).resolves.toEqual({
      allowed: false, used: 2, limit: 2, plan: 'free', windowStart: new Date(WINDOW),
    })
  })

  it('treats a null limit as unlimited', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 99 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('team', { max_reviews_per_month: null }))
    const result = await checkReviewLimit('u1')
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(Number.POSITIVE_INFINITY)
  })

  it('defaults to 2 when there is no plan row at all', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 0 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('free', null))
    await expect(checkReviewLimit('u1')).resolves.toMatchObject({ allowed: true, used: 0, limit: 2 })
  })

  it('bypasses the gate for a super admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkReviewLimit('u1')).resolves.toMatchObject({ allowed: true, plan: 'super_admin' })
  })

  it('counts the ledger, not review_sessions — deleting a manuscript refunds nothing', async () => {
    // THE REGRESSION TEST FOR THIS ENTIRE CHANGE.
    //
    // The old implementation walked manuscripts -> drafts -> review_sessions,
    // all of which cascade on delete, so a deleted manuscript handed the
    // allowance back. Here the manuscript, its drafts and its sessions are all
    // gone — and the user is still correctly at their cap, because the ledger
    // is not reachable by that cascade.
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      manuscripts: { data: [], count: 0 },
      drafts: { data: [] },
      review_sessions: { count: 0 },
      usage_events: { count: 2 },
    })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('free', { max_reviews_per_month: 2 }))

    const result = await checkReviewLimit('u1')

    expect(result.used).toBe(2)
    expect(result.allowed).toBe(false)
    // And prove it never consulted the cascading tables at all.
    const tables = h.admin.from.mock.calls.map((c) => c[0])
    expect(tables).not.toContain('drafts')
    expect(tables).not.toContain('review_sessions')
  })
})

describe('checkFeatureGate', () => {
  const ctx = (planId: string, plan: Record<string, unknown> | null) => ({
    planId, plan, windowStart: new Date('2026-07-01T00:00:00.000Z'),
  })

  it('allows when the plan flag is true', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('pro', { adversarial_access: true }))
    await expect(checkFeatureGate('u1', 'adversarial_access')).resolves.toEqual({ allowed: true, plan: 'pro' })
  })

  it('blocks when the plan flag is false', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('free', { adversarial_access: false }))
    await expect(checkFeatureGate('u1', 'adversarial_access')).resolves.toEqual({ allowed: false, plan: 'free' })
  })

  it('bypasses entirely for super_admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkFeatureGate('u1', 'pdf_reports')).resolves.toEqual({ allowed: true, plan: 'super_admin' })
  })
})
