import { describe, it, expect } from 'vitest'
import { withCompletedReview, type ReviewableManuscript } from '@/lib/manuscripts/reviewed'

const m = (id: string, sessions: { status: string; overall_score?: number | null }[]): ReviewableManuscript => ({
  id,
  title: `Manuscript ${id}`,
  drafts: [{ id: `d-${id}`, version_number: 1, review_sessions: sessions.map((s, i) => ({
    id: `s-${id}-${i}`, status: s.status, overall_score: s.overall_score ?? null, completed_at: null,
  })) }],
})

describe('withCompletedReview', () => {
  it('keeps only manuscripts with at least one complete session', () => {
    const result = withCompletedReview([
      m('a', [{ status: 'complete', overall_score: 7 }]),
      m('b', [{ status: 'failed' }]),
      m('c', [{ status: 'reviewing' }]),
      m('d', []),
    ])
    expect(result.map((r) => r.id)).toEqual(['a'])
  })

  it('surfaces the latest completed score across all drafts', () => {
    const manuscript: ReviewableManuscript = {
      id: 'x',
      title: 'X',
      drafts: [
        { id: 'd1', version_number: 1, review_sessions: [
          { id: 's1', status: 'complete', overall_score: 5, completed_at: '2026-01-01T00:00:00Z' },
        ] },
        { id: 'd2', version_number: 2, review_sessions: [
          { id: 's2', status: 'complete', overall_score: 8, completed_at: '2026-02-01T00:00:00Z' },
        ] },
      ],
    }
    const [only] = withCompletedReview([manuscript])
    expect(only.lastScore).toBe(8)
    expect(only.reviewCount).toBe(2)
  })

  it('tolerates a manuscript with no drafts array at all', () => {
    const result = withCompletedReview([{ id: 'z', title: 'Z' } as ReviewableManuscript])
    expect(result).toEqual([])
  })
})
