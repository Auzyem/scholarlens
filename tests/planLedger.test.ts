import { describe, it, expect, vi } from 'vitest'

// Mock the service-role client so the real lib/supabase/admin (which imports
// 'server-only') never loads under Vitest, matching tests/planGates.test.ts.
// Each table gets one canned response per test; every function under test
// queries a given table at most once per call.
//
// `filterCalls` records every eq/in/gte invocation (in call order) rather than
// merely chaining through: the counting rule and the release/commit
// idempotency both live entirely in which filters get applied, so a vacuous
// mock that just returns the builder would let those filters be deleted
// without any test noticing. See tests/planGates.test.ts's `neqCalls` for the
// same pattern.
function mockAdmin(
  responses: Record<string, unknown>,
  calls: Record<string, unknown>[] = [],
  filterCalls: [string, unknown[]][] = [],
) {
  return {
    from: vi.fn((table: string) => {
      const result = responses[table] ?? { data: null, count: 0 }
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'is']) {
        builder[m] = vi.fn(() => builder)
      }
      for (const m of ['eq', 'gte', 'in']) {
        builder[m] = vi.fn((...args: unknown[]) => {
          filterCalls.push([m, args])
          return builder
        })
      }
      builder.insert = vi.fn((row: unknown) => {
        calls.push({ table, op: 'insert', row })
        return builder
      })
      builder.update = vi.fn((patch: unknown) => {
        calls.push({ table, op: 'update', patch })
        return builder
      })
      builder.single = vi.fn(async () => result)
      builder.maybeSingle = vi.fn(async () => result)
      ;(builder as unknown as PromiseLike<unknown>).then = (resolve: (v: unknown) => void) =>
        resolve(result)
      return builder
    }),
  }
}

const h = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof mockAdmin> }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }))

import {
  resolveQuotaContext,
  countUsage,
  insertReservation,
  releaseReviewCredit,
  commitReviewCredit,
} from '@/lib/plan/ledger'

describe('resolveQuotaContext', () => {
  it('uses the billing anniversary for a resetting plan', async () => {
    h.admin = mockAdmin({
      subscriptions: {
        data: {
          plan_id: 'pro',
          current_period_start: '2026-07-28T09:15:00.000Z',
          plans: { quota_resets: true, max_reviews_per_month: 30 },
        },
      },
      profiles: { data: { created_at: '2025-01-01T00:00:00.000Z' } },
    })
    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))
    expect(ctx.planId).toBe('pro')
    expect(ctx.windowStart.toISOString()).toBe('2026-07-28T09:15:00.000Z')
  })

  it('uses the account creation date for a non-resetting plan', async () => {
    h.admin = mockAdmin({
      subscriptions: {
        data: {
          plan_id: 'free',
          current_period_start: null,
          plans: { quota_resets: false, max_reviews_per_month: 2 },
        },
      },
      profiles: { data: { created_at: '2025-11-03T08:30:00.000Z' } },
    })
    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))
    expect(ctx.planId).toBe('free')
    expect(ctx.windowStart.toISOString()).toBe('2025-11-03T08:30:00.000Z')
  })

  it('defaults to the free plan when there is no subscription row', async () => {
    h.admin = mockAdmin({
      subscriptions: { data: null },
      profiles: { data: { created_at: '2025-11-03T08:30:00.000Z' } },
    })
    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))
    expect(ctx.planId).toBe('free')
    expect(ctx.plan).toBeNull()
  })
})

describe('countUsage', () => {
  it('counts reserved and consumed rows in the window', async () => {
    h.admin = mockAdmin({ usage_events: { count: 3 } })
    await expect(
      countUsage('u1', 'review', new Date('2026-07-01T00:00:00Z'))
    ).resolves.toBe(3)
  })

  it('returns 0 when the query yields no count', async () => {
    h.admin = mockAdmin({ usage_events: { count: null } })
    await expect(
      countUsage('u1', 'review', new Date('2026-07-01T00:00:00Z'))
    ).resolves.toBe(0)
  })

  it('counts only reserved and consumed rows, scoped to the user, kind and window', async () => {
    // The mock above hands back a canned count no matter what filters are
    // applied, so it can't tell a correct query from a broken one on its own.
    // This asserts the filters themselves — in particular the
    // in('state', ['reserved', 'consumed']) call that IS the counting rule.
    // Deleting it would let 'released' rows count toward every user's limit,
    // and every other test here would keep passing.
    const filterCalls: [string, unknown[]][] = []
    h.admin = mockAdmin({ usage_events: { count: 3 } }, [], filterCalls)

    await countUsage('u1', 'review', new Date('2026-07-01T00:00:00Z'))

    expect(filterCalls).toEqual([
      ['eq', ['user_id', 'u1']],
      ['eq', ['kind', 'review']],
      ['in', ['state', ['reserved', 'consumed']]],
      ['gte', ['window_start', '2026-07-01T00:00:00.000Z']],
    ])
  })
})

describe('insertReservation', () => {
  it('writes a reserved review row and returns its id', async () => {
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin({ usage_events: { data: { id: 'evt-1' } } }, calls)

    const id = await insertReservation('u1', new Date('2026-07-01T00:00:00Z'), 'sess-1')

    expect(id).toBe('evt-1')
    expect(calls).toEqual([
      {
        table: 'usage_events',
        op: 'insert',
        row: {
          user_id: 'u1',
          kind: 'review',
          state: 'reserved',
          review_session_id: 'sess-1',
          window_start: '2026-07-01T00:00:00.000Z',
        },
      },
    ])
  })
})

describe('releaseReviewCredit', () => {
  it('releases only the reservation still held for that session', async () => {
    const calls: Record<string, unknown>[] = []
    const filterCalls: [string, unknown[]][] = []
    h.admin = mockAdmin({ usage_events: { data: [] } }, calls, filterCalls)

    await releaseReviewCredit('sess-1')

    // The eq('state','reserved') filter is what makes this idempotent: calling
    // it twice matches zero rows the second time.
    expect(calls).toEqual([
      { table: 'usage_events', op: 'update', patch: { state: 'released' } },
    ])
    expect(filterCalls).toEqual([
      ['eq', ['review_session_id', 'sess-1']],
      ['eq', ['kind', 'review']],
      ['eq', ['state', 'reserved']],
    ])
  })
})

describe('commitReviewCredit', () => {
  it('consumes the review credit and charges the manuscript slot', async () => {
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin({ usage_events: { data: [], error: null } }, calls)

    await commitReviewCredit({
      sessionId: 'sess-1',
      userId: 'u1',
      manuscriptId: 'man-1',
      windowStart: new Date('2026-07-01T00:00:00Z'),
    })

    expect(calls[0]).toMatchObject({ table: 'usage_events', op: 'update' })
    expect((calls[0] as { patch: { state: string } }).patch.state).toBe('consumed')
    expect(calls[1]).toEqual({
      table: 'usage_events',
      op: 'insert',
      row: {
        user_id: 'u1',
        kind: 'manuscript_slot',
        state: 'consumed',
        manuscript_id: 'man-1',
        window_start: '2026-07-01T00:00:00.000Z',
        consumed_at: expect.any(String),
      },
    })
  })

  it('swallows the unique violation when the slot was already charged', async () => {
    // A re-review hits the partial unique index. That is the mechanism that
    // makes a re-review cost a credit but not a second slot — not an error.
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin({ usage_events: { data: null, error: { code: '23505' } } }, calls)

    await expect(
      commitReviewCredit({
        sessionId: 'sess-2',
        userId: 'u1',
        manuscriptId: 'man-1',
        windowStart: new Date('2026-07-01T00:00:00Z'),
      })
    ).resolves.toBeUndefined()
  })
})
