/**
 * Which manuscripts can be re-reviewed, and how they last scored.
 *
 * Pure so it can be tested without a network round trip; the shape matches what
 * `GET /api/manuscripts` already returns, so the Re-Review page needs no new
 * endpoint.
 */

export interface ReviewableSession {
  id: string
  status: string
  overall_score: number | null
  completed_at: string | null
}

export interface ReviewableManuscript {
  id: string
  title: string
  drafts?: { id: string; version_number: number; review_sessions?: ReviewableSession[] }[]
}

export interface ReReviewCandidate {
  id: string
  title: string
  reviewCount: number
  lastScore: number | null
  lastReviewedAt: string | null
}

export function withCompletedReview(manuscripts: ReviewableManuscript[]): ReReviewCandidate[] {
  const candidates: ReReviewCandidate[] = []

  for (const manuscript of manuscripts) {
    const completed = (manuscript.drafts ?? [])
      .flatMap((d) => d.review_sessions ?? [])
      .filter((s) => s.status === 'complete')

    if (completed.length === 0) continue

    // Null completed_at sorts oldest so a session that completed without the
    // timestamp never masks one that has it.
    const latest = completed.reduce((newest, s) =>
      (s.completed_at ?? '') > (newest.completed_at ?? '') ? s : newest
    )

    candidates.push({
      id: manuscript.id,
      title: manuscript.title,
      reviewCount: completed.length,
      lastScore: latest.overall_score,
      lastReviewedAt: latest.completed_at,
    })
  }

  return candidates
}
