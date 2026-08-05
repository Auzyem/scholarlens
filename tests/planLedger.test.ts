import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the one module that touches the Sentry SDK, matching tests/db/mustWrite.
// The ledger never throws on a write failure — reporting IS the only observable
// effect, so it has to be observable here too.
const m = vi.hoisted(() => ({
  errors: [] as Array<{ error: unknown; ctx?: Record<string, unknown> }>,
  warnings: [] as Array<{ message: string; ctx?: Record<string, unknown> }>,
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  reportError: (error: unknown, ctx?: Record<string, unknown>) => m.errors.push({ error, ctx }),
  reportWarning: (message: string, ctx?: Record<string, unknown>) =>
    m.warnings.push({ message, ctx }),
  flushMonitoring: vi.fn(),
}))

beforeEach(() => {
  m.errors.length = 0
  m.warnings.length = 0
})

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
//
// A table whose entry is an *array* hands back one response per `from()` call,
// in order, reusing the last once exhausted. commitReviewCredit is the only
// function that queries a table more than once per call — it reads the
// reservations, updates them, then inserts the slot — and those steps need to
// be able to answer differently (a clean read followed by a 23505 insert).
function mockAdmin(
  responses: Record<string, unknown>,
  calls: Record<string, unknown>[] = [],
  filterCalls: [string, unknown[]][] = [],
) {
  const queues: Record<string, unknown[]> = {}
  for (const [table, entry] of Object.entries(responses)) {
    if (Array.isArray(entry)) queues[table] = [...entry]
  }
  return {
    from: vi.fn((table: string) => {
      const queue = queues[table]
      const result = queue
        ? queue.length > 1
          ? queue.shift()
          : (queue[0] ?? { data: null, count: 0 })
        : (responses[table] ?? { data: null, count: 0 })
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
  chargedSlotManuscriptIds,
  insertReservation,
  attachSessionToReservation,
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

  it('does not restore a monthly window when the profile is unreadable on a non-resetting plan', async () => {
    // The profiles read failed, or handle_new_user never wrote the row. A
    // calendar-month window here would hand the one-time Free allowance a fresh
    // 2 reviews every month — the exact bug the plan flag exists to prevent.
    h.admin = mockAdmin({
      subscriptions: {
        data: {
          plan_id: 'free',
          current_period_start: '2026-07-28T09:15:00.000Z',
          plans: { quota_resets: false, max_reviews_per_month: 2 },
        },
      },
      profiles: { data: null, error: { message: 'timeout' } },
    })

    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))

    expect(ctx.windowStart.toISOString()).toBe('1970-01-01T00:00:00.000Z')
    expect(m.errors).toHaveLength(1)
    expect(m.errors[0].ctx).toMatchObject({ userId: 'u1' })
  })

  it('reports an unreadable subscription instead of silently resolving as free', async () => {
    // A failed subscriptions read is indistinguishable from having no
    // subscription: the caller gets the free plan's limits either way. The
    // quota still resolves — no throw — but a paying user being metered as free
    // must not be invisible.
    h.admin = mockAdmin({
      subscriptions: { data: null, error: { message: 'reset' } },
      profiles: { data: { created_at: '2025-11-03T08:30:00.000Z' } },
    })

    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))

    expect(ctx.planId).toBe('free')
    expect(m.errors).toHaveLength(1)
    expect(m.errors[0].ctx).toMatchObject({ userId: 'u1' })
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

describe('chargedSlotManuscriptIds', () => {
  const windowStart = new Date('2026-07-01T00:00:00Z')

  it('puts slots charged at or after windowStart in both inWindow and ever', async () => {
    h.admin = mockAdmin({
      usage_events: {
        data: [
          // Exactly on the boundary: the comparison is >=, so this counts now.
          { manuscript_id: 'm-boundary', window_start: '2026-07-01T00:00:00.000Z' },
          { manuscript_id: 'm-later', window_start: '2026-07-15T10:00:00.000Z' },
        ],
      },
    })

    const { inWindow, ever } = await chargedSlotManuscriptIds('u1', windowStart)

    expect([...inWindow].sort()).toEqual(['m-boundary', 'm-later'])
    expect([...ever].sort()).toEqual(['m-boundary', 'm-later'])
  })

  it('puts slots charged before windowStart in ever only', async () => {
    // This is what stops a manuscript being charged a second slot in a later
    // window: it is not in `inWindow` (so it costs nothing now) but it is in
    // `ever` (so it is not treated as live-but-uncharged either).
    h.admin = mockAdmin({
      usage_events: {
        data: [
          { manuscript_id: 'm-old', window_start: '2026-06-30T23:59:59.999Z' },
          { manuscript_id: 'm-now', window_start: '2026-07-02T00:00:00.000Z' },
        ],
      },
    })

    const { inWindow, ever } = await chargedSlotManuscriptIds('u1', windowStart)

    expect([...inWindow]).toEqual(['m-now'])
    expect([...ever].sort()).toEqual(['m-now', 'm-old'])
  })

  it('skips rows with no manuscript', async () => {
    h.admin = mockAdmin({
      usage_events: {
        data: [
          { manuscript_id: null, window_start: '2026-07-15T10:00:00.000Z' },
          { manuscript_id: 'm-1', window_start: '2026-07-15T10:00:00.000Z' },
        ],
      },
    })

    const { inWindow, ever } = await chargedSlotManuscriptIds('u1', windowStart)

    expect([...inWindow]).toEqual(['m-1'])
    expect([...ever]).toEqual(['m-1'])
  })

  it('reads only reserved and consumed slot rows, scoped to the user', async () => {
    // Same reasoning as the countUsage filter test: the mock returns its canned
    // rows whatever is asked, so only the filters themselves prove the counting
    // rule holds here. Dropping in('state', ...) would make a *released* slot
    // look charged, permanently blocking that manuscript from being charged.
    const filterCalls: [string, unknown[]][] = []
    h.admin = mockAdmin({ usage_events: { data: [] } }, [], filterCalls)

    await chargedSlotManuscriptIds('u1', windowStart)

    expect(filterCalls).toEqual([
      ['eq', ['user_id', 'u1']],
      ['eq', ['kind', 'manuscript_slot']],
      ['in', ['state', ['reserved', 'consumed']]],
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

  it('reports a failed reservation instead of failing silently', async () => {
    // Callers in confirm/retry discard the return value, so the review runs
    // free. That under-bills, which is allowed — being invisible is not.
    h.admin = mockAdmin({ usage_events: { data: null, error: { message: 'timeout' } } })

    const id = await insertReservation('u1', new Date('2026-07-01T00:00:00Z'), 'sess-1')

    expect(id).toBeNull()
    expect(m.errors).toHaveLength(1)
    expect(m.errors[0].ctx).toMatchObject({ userId: 'u1', sessionId: 'sess-1' })
  })
})

describe('attachSessionToReservation', () => {
  it('reports a failed attach, which would otherwise strand the credit', async () => {
    // A row left with review_session_id = null can never be found by a release
    // or a commit, so its credit is occupied for good.
    h.admin = mockAdmin({ usage_events: { data: null, error: { message: 'conflict' } } })

    await attachSessionToReservation('evt-1', 'sess-1')

    expect(m.errors).toHaveLength(1)
    expect(m.errors[0].ctx).toMatchObject({ eventId: 'evt-1', sessionId: 'sess-1' })
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
    expect(m.errors).toEqual([])
  })

  it('reports a failed release rather than swallowing it', async () => {
    // A swallowed failure leaves the row reserved; a later re-reservation for
    // the same session then gives that session two reserved rows.
    h.admin = mockAdmin({ usage_events: { data: null, error: { message: 'reset' } } })

    await releaseReviewCredit('sess-1')

    expect(m.errors).toHaveLength(1)
    expect(m.errors[0].ctx).toMatchObject({ sessionId: 'sess-1' })
  })
})

describe('commitReviewCredit', () => {
  const slotRow = {
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
  }

  it('consumes the review credit and charges the manuscript slot', async () => {
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin(
      {
        usage_events: [
          { data: [{ id: 'evt-1' }] }, // read the reservations
          { data: null, error: null }, // consume that one
          { data: null, error: null }, // charge the slot
        ],
      },
      calls,
    )

    await commitReviewCredit({
      sessionId: 'sess-1',
      userId: 'u1',
      manuscriptId: 'man-1',
      windowStart: new Date('2026-07-01T00:00:00Z'),
    })

    expect(calls[0]).toMatchObject({ table: 'usage_events', op: 'update' })
    expect((calls[0] as { patch: { state: string } }).patch.state).toBe('consumed')
    expect(calls[1]).toEqual(slotRow)
    // Exactly two writes: one consume, no stray release.
    expect(calls).toHaveLength(2)
  })

  it('consumes only the oldest reservation and releases the rest', async () => {
    // Two reserved rows for one session means an earlier release failed and
    // confirm/retry re-reserved. Consuming both would charge the user twice
    // for the single review they received.
    const calls: Record<string, unknown>[] = []
    const filterCalls: [string, unknown[]][] = []
    h.admin = mockAdmin(
      {
        usage_events: [
          { data: [{ id: 'r1' }, { id: 'r2' }] },
          { data: null, error: null },
          { data: null, error: null },
          { data: null, error: null },
        ],
      },
      calls,
      filterCalls,
    )

    await commitReviewCredit({
      sessionId: 'sess-1',
      userId: 'u1',
      manuscriptId: 'man-1',
      windowStart: new Date('2026-07-01T00:00:00Z'),
    })

    expect((calls[0] as { patch: { state: string } }).patch.state).toBe('consumed')
    expect(calls[1]).toEqual({
      table: 'usage_events',
      op: 'update',
      patch: { state: 'released' },
    })
    expect(calls[2]).toEqual(slotRow)

    // Both updates are addressed by id: one row consumed, the surplus released.
    expect(filterCalls).toEqual([
      ['eq', ['review_session_id', 'sess-1']],
      ['eq', ['kind', 'review']],
      ['eq', ['state', 'reserved']],
      ['eq', ['id', 'r1']],
      ['in', ['id', ['r2']]],
    ])
  })

  it('charges the slot but warns when there is no reservation to consume', async () => {
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin(
      { usage_events: [{ data: [] }, { data: null, error: null }] },
      calls,
    )

    await commitReviewCredit({
      sessionId: 'sess-1',
      userId: 'u1',
      manuscriptId: 'man-1',
      windowStart: new Date('2026-07-01T00:00:00Z'),
    })

    // Under-billing the review is acceptable; the slot is still charged.
    expect(calls).toEqual([slotRow])
    expect(m.warnings).toHaveLength(1)
    expect(m.warnings[0].ctx).toMatchObject({ sessionId: 'sess-1', userId: 'u1' })
  })

  it('swallows the unique violation when the slot was already charged', async () => {
    // A re-review hits the partial unique index. That is the mechanism that
    // makes a re-review cost a credit but not a second slot — not an error.
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin(
      {
        usage_events: [
          { data: [{ id: 'evt-1' }] },
          { data: null, error: null },
          { data: null, error: { code: '23505' } },
        ],
      },
      calls,
    )

    await expect(
      commitReviewCredit({
        sessionId: 'sess-2',
        userId: 'u1',
        manuscriptId: 'man-1',
        windowStart: new Date('2026-07-01T00:00:00Z'),
      })
    ).resolves.toBeUndefined()
    expect(m.errors).toEqual([])
  })
})
