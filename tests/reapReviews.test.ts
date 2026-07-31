import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Mock the service-role client so the real lib/supabase/admin (which imports
 * 'server-only') never loads under Vitest — same pattern as tests/planGates.test.ts.
 *
 * Every builder records its calls so the tests can assert on the SHAPE of the
 * update, which is the race-safety contract: the update must re-assert both the
 * observed status and the overdue clock, or a pipeline that finishes mid-sweep
 * would be overwritten with 'failed'.
 *
 * `select` is terminal on the update chain but chainable on the read chain, so
 * each builder tracks whether `update` was called on it and resolves
 * accordingly. That is why `from()` hands out a fresh builder every time.
 */
interface UpdateCall {
  patch: Record<string, unknown>
  eq: [string, unknown][]
  lt: [string, unknown][]
}

const h = vi.hoisted(() => ({
  selectResult: { data: [] as unknown[], error: null as { message: string } | null },
  updateResult: { data: [{ id: 'sess-1' }] as unknown[], error: null as { message: string } | null },
  updateCalls: [] as UpdateCall[],
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const call: UpdateCall = { patch: {}, eq: [], lt: [] }
      let isUpdate = false
      const builder: Record<string, unknown> = {}

      builder.update = vi.fn((patch: Record<string, unknown>) => {
        isUpdate = true
        call.patch = patch
        h.updateCalls.push(call)
        return builder
      })
      builder.select = vi.fn(() =>
        isUpdate ? Promise.resolve(h.updateResult) : builder
      )
      builder.or = vi.fn(() => builder)
      builder.limit = vi.fn(async () => h.selectResult)
      builder.eq = vi.fn((col: string, val: unknown) => {
        call.eq.push([col, val])
        return builder
      })
      builder.lt = vi.fn((col: string, val: unknown) => {
        call.lt.push([col, val])
        return builder
      })
      return builder
    },
  }),
}))

import { GET } from '@/app/api/cron/reap-reviews/route'

const SECRET = 'test-cron-secret'
const req = (auth?: string) =>
  new Request('http://localhost/api/cron/reap-reviews', {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as Parameters<typeof GET>[0]

const stuckRow = {
  id: 'sess-1',
  status: 'reviewing',
  status_updated_at: '2020-01-01T00:00:00.000Z',
  adversarial_status: 'not_started',
  adversarial_status_updated_at: '2020-01-01T00:00:00.000Z',
  journal_match_status: 'not_started',
  journal_match_status_updated_at: '2020-01-01T00:00:00.000Z',
  reporting_check_status: 'not_started',
  reporting_check_status_updated_at: '2020-01-01T00:00:00.000Z',
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  h.selectResult = { data: [], error: null }
  h.updateResult = { data: [{ id: 'sess-1' }], error: null }
  h.updateCalls = []
})

describe('reap-reviews auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(h.updateCalls).toHaveLength(0)
  })

  it('rejects a wrong secret', async () => {
    const res = await GET(req('Bearer wrong-secret-value'))
    expect(res.status).toBe(401)
  })

  it('fails CLOSED when CRON_SECRET is not configured', async () => {
    // An unset secret must never mean "no auth required" — that would make this
    // a public endpoint for failing other people's reviews.
    delete process.env.CRON_SECRET
    const res = await GET(req('Bearer '))
    expect(res.status).toBe(401)
  })

  it('accepts the correct secret', async () => {
    const res = await GET(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
  })
})

describe('reap-reviews sweep', () => {
  it('reaps a stuck session and reports it', async () => {
    h.selectResult = { data: [stuckRow], error: null }
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.scanned).toBe(1)
    expect(body.reaped).toEqual([{ sessionId: 'sess-1', column: 'status', from: 'reviewing' }])
  })

  it('guards the update with BOTH the status and the clock', async () => {
    // This is the race-safety contract. Without both predicates, a pipeline that
    // completes during the sweep would be overwritten with 'failed'.
    h.selectResult = { data: [stuckRow], error: null }
    await GET(req(`Bearer ${SECRET}`))

    expect(h.updateCalls).toHaveLength(1)
    const call = h.updateCalls[0]
    expect(call.patch.status).toBe('failed')
    expect(call.patch.error_message).toBeTruthy()
    expect(call.eq).toContainEqual(['id', 'sess-1'])
    expect(call.eq).toContainEqual(['status', 'reviewing'])
    expect(call.lt.map(([c]) => c)).toContain('status_updated_at')
  })

  it('does not count a row that changed mid-sweep as reaped', async () => {
    // The conditional update matched zero rows — the pipeline won the race.
    h.selectResult = { data: [stuckRow], error: null }
    h.updateResult = { data: [], error: null }
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.reaped).toEqual([])
  })

  it('does not touch awaiting_confirmation rows', async () => {
    h.selectResult = { data: [{ ...stuckRow, status: 'awaiting_confirmation' }], error: null }
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.reaped).toEqual([])
    expect(h.updateCalls).toHaveLength(0)
  })

  it('reaps a stuck sub-pipeline without writing error_message', async () => {
    // Only the main lifecycle has an error_message column to write to.
    h.selectResult = {
      data: [{ ...stuckRow, status: 'complete', adversarial_status: 'running' }],
      error: null,
    }
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.reaped).toEqual([
      { sessionId: 'sess-1', column: 'adversarial_status', from: 'running' },
    ])
    expect(h.updateCalls[0].patch).toEqual({ adversarial_status: 'failed' })
  })

  it('surfaces a failed candidate query as a 500', async () => {
    h.selectResult = { data: [], error: { message: 'boom' } }
    const res = await GET(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
  })
})
