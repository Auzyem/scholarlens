import { createAdminClient } from '@/lib/supabase/admin'
import type { ScoreDimension } from '@/lib/types'

type Verdict = 'accept' | 'minor_revision' | 'major_revision' | 'reject'
const VERDICTS: Verdict[] = ['accept', 'minor_revision', 'major_revision', 'reject']

export interface UserStats {
  manuscripts: number
  reviews: number
  avgScore: number | null
  avgTurnaroundHours: number | null
  verdicts: Record<Verdict, number>
  dimensionAverages: { dimension: ScoreDimension; score: number }[]
}

const EMPTY_VERDICTS = (): Record<Verdict, number> => ({
  accept: 0,
  minor_revision: 0,
  major_revision: 0,
  reject: 0,
})

export async function getUserStats(userId: string): Promise<UserStats> {
  const admin = createAdminClient()

  const { count: manuscriptCount } = await admin
    .from('manuscripts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)

  const { data: manuscripts } = await admin.from('manuscripts').select('id').eq('user_id', userId)
  const manuscriptIds = (manuscripts ?? []).map((m) => m.id)
  if (manuscriptIds.length === 0) {
    return {
      manuscripts: manuscriptCount ?? 0,
      reviews: 0,
      avgScore: null,
      avgTurnaroundHours: null,
      verdicts: EMPTY_VERDICTS(),
      dimensionAverages: [],
    }
  }

  const { data: drafts } = await admin.from('drafts').select('id').in('manuscript_id', manuscriptIds)
  const draftIds = (drafts ?? []).map((d) => d.id)
  if (draftIds.length === 0) {
    return {
      manuscripts: manuscriptCount ?? 0,
      reviews: 0,
      avgScore: null,
      avgTurnaroundHours: null,
      verdicts: EMPTY_VERDICTS(),
      dimensionAverages: [],
    }
  }

  const { data: sessions } = await admin
    .from('review_sessions')
    .select('id, overall_score, verdict, created_at, completed_at')
    .eq('status', 'complete')
    .in('draft_id', draftIds)

  const completed = sessions ?? []
  const reviews = completed.length

  if (reviews === 0) {
    return {
      manuscripts: manuscriptCount ?? 0,
      reviews: 0,
      avgScore: null,
      avgTurnaroundHours: null,
      verdicts: EMPTY_VERDICTS(),
      dimensionAverages: [],
    }
  }

  const scored = completed.filter((s) => typeof s.overall_score === 'number')
  const avgScore = scored.length
    ? scored.reduce((sum, s) => sum + (s.overall_score as number), 0) / scored.length
    : null

  const timed = completed.filter((s) => s.created_at && s.completed_at)
  const avgTurnaroundHours = timed.length
    ? timed.reduce((sum, s) => {
        const hours = (new Date(s.completed_at as string).getTime() - new Date(s.created_at as string).getTime()) / 3_600_000
        return sum + hours
      }, 0) / timed.length
    : null

  const verdicts = EMPTY_VERDICTS()
  for (const s of completed) {
    if (s.verdict && VERDICTS.includes(s.verdict as Verdict)) {
      verdicts[s.verdict as Verdict] += 1
    }
  }

  const sessionIds = completed.map((s) => s.id)
  const { data: scores } = await admin
    .from('scores')
    .select('dimension, score')
    .in('session_id', sessionIds)

  const byDimension = new Map<ScoreDimension, number[]>()
  for (const row of scores ?? []) {
    const dim = row.dimension as ScoreDimension
    const arr = byDimension.get(dim) ?? []
    arr.push(row.score as number)
    byDimension.set(dim, arr)
  }
  const dimensionAverages = Array.from(byDimension.entries()).map(([dimension, values]) => ({
    dimension,
    score: values.reduce((a, b) => a + b, 0) / values.length,
  }))

  return {
    manuscripts: manuscriptCount ?? 0,
    reviews,
    avgScore,
    avgTurnaroundHours,
    verdicts,
    dimensionAverages,
  }
}
