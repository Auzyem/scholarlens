import { describe, it, expect, vi } from 'vitest'

// Mocking pattern shared with tests/planGates.test.ts — a per-table canned
// response, thenable so `await admin.from(t)...` resolves without a terminal
// method call. The 'manuscripts' table is queried twice (a head:true count,
// then a plain id list) so its canned response carries both `count` and `data`.
function mockAdmin(responses: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) => {
      const result = responses[table] ?? { data: null, count: 0 }
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order']) {
        builder[m] = vi.fn(() => builder)
      }
      builder.single = vi.fn(async () => result)
      ;(builder as unknown as PromiseLike<unknown>).then = (resolve: (v: unknown) => void) => resolve(result)
      return builder
    }),
  }
}

const h = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof mockAdmin> }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }))

import { getUserStats } from '@/lib/stats/userStats'

describe('getUserStats', () => {
  it('returns a full empty state when the user has no manuscripts', async () => {
    h.admin = mockAdmin({ manuscripts: { count: 0, data: [] } })
    await expect(getUserStats('u1')).resolves.toEqual({
      manuscripts: 0,
      reviews: 0,
      avgScore: null,
      avgTurnaroundHours: null,
      verdicts: { accept: 0, minor_revision: 0, major_revision: 0, reject: 0 },
      dimensionAverages: [],
    })
  })

  it('returns zero reviews when manuscripts exist but no completed sessions do', async () => {
    h.admin = mockAdmin({
      manuscripts: { count: 2, data: [{ id: 'm1' }] },
      drafts: { data: [{ id: 'd1' }] },
      review_sessions: { data: [] },
    })
    const result = await getUserStats('u1')
    expect(result.manuscripts).toBe(2)
    expect(result.reviews).toBe(0)
    expect(result.avgScore).toBeNull()
  })

  it('averages scores, turnaround, and counts verdicts across completed sessions', async () => {
    h.admin = mockAdmin({
      manuscripts: { count: 1, data: [{ id: 'm1' }] },
      drafts: { data: [{ id: 'd1' }] },
      review_sessions: {
        data: [
          { id: 's1', overall_score: 8, verdict: 'accept', created_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T02:00:00Z' },
          { id: 's2', overall_score: 6, verdict: 'minor_revision', created_at: '2026-07-02T00:00:00Z', completed_at: '2026-07-02T06:00:00Z' },
        ],
      },
      scores: {
        data: [
          { dimension: 'originality', score: 7 },
          { dimension: 'originality', score: 9 },
          { dimension: 'methodology', score: 5 },
        ],
      },
    })
    const result = await getUserStats('u1')
    expect(result.reviews).toBe(2)
    expect(result.avgScore).toBe(7) // (8 + 6) / 2
    expect(result.avgTurnaroundHours).toBe(4) // (2 + 6) / 2
    expect(result.verdicts).toEqual({ accept: 1, minor_revision: 1, major_revision: 0, reject: 0 })
    expect(result.dimensionAverages).toEqual(
      expect.arrayContaining([
        { dimension: 'originality', score: 8 }, // (7 + 9) / 2
        { dimension: 'methodology', score: 5 },
      ])
    )
  })
})
