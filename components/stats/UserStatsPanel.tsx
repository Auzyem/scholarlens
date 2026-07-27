'use client'
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { ScoreRadar } from '@/components/review/ScoreRadar'
import type { Score, ScoreDimension } from '@/lib/types'

type Verdict = 'accept' | 'minor_revision' | 'major_revision' | 'reject'

interface Stats {
  manuscripts: number
  reviews: number
  avgScore: number | null
  avgTurnaroundHours: number | null
  verdicts: Record<Verdict, number>
  dimensionAverages: { dimension: ScoreDimension; score: number }[]
}

// The dataviz skill's fixed, never-themed status palette — mapped 1:1 to the
// four verdicts. Light-mode warning/serious sit under 3:1 contrast by design;
// the direct label on every bar is the documented mitigation.
const VERDICT_META: Record<Verdict, { label: string; color: string }> = {
  accept: { label: 'Accept', color: '#0ca30c' },
  minor_revision: { label: 'Minor revision', color: '#fab219' },
  major_revision: { label: 'Major revision', color: '#ec835a' },
  reject: { label: 'Reject', color: '#d03b3b' },
}
const VERDICT_ORDER: Verdict[] = ['accept', 'minor_revision', 'major_revision', 'reject']

function formatTurnaround(hours: number): string {
  if (hours < 24) {
    const h = Math.floor(hours)
    const m = Math.round((hours - h) * 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${(hours / 24).toFixed(1)} days`
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function VerdictBars({ verdicts }: { verdicts: Record<Verdict, number> }) {
  const max = Math.max(...VERDICT_ORDER.map((v) => verdicts[v]), 1)
  return (
    <div className="space-y-2.5">
      {VERDICT_ORDER.map((v) => {
        const count = verdicts[v]
        const pct = (count / max) * 100
        return (
          <div key={v} className="flex items-center gap-3 text-sm">
            <span className="w-32 shrink-0 text-muted-foreground">{VERDICT_META[v].label}</span>
            <div className="h-3 flex-1 rounded-sm bg-muted">
              <div
                className="h-full rounded-sm transition-all"
                style={{ width: `${pct}%`, backgroundColor: VERDICT_META[v].color }}
              />
            </div>
            <span className="w-6 shrink-0 text-right font-medium tabular-nums">{count}</span>
          </div>
        )
      })}
    </div>
  )
}

export function UserStatsPanel({ userId }: { userId?: string }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const url = userId ? `/api/admin/users/${userId}/stats` : '/api/stats/me'
    fetch(url)
      .then(async (r) => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error ?? 'Failed to load stats')
        setStats(data)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load stats'))
  }, [userId])

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!stats) return <p className="text-sm text-muted-foreground">Loading…</p>

  const asScores: Score[] = stats.dimensionAverages.map((d) => ({
    id: d.dimension,
    session_id: '',
    dimension: d.dimension,
    score: d.score,
    max_score: 10,
  }))

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Manuscripts" value={String(stats.manuscripts)} />
        <Tile label="Reviews completed" value={String(stats.reviews)} />
        <Tile label="Average score" value={stats.avgScore !== null ? `${stats.avgScore.toFixed(1)}/10` : '—'} />
        <Tile
          label="Average turnaround"
          value={stats.avgTurnaroundHours !== null ? formatTurnaround(stats.avgTurnaroundHours) : '—'}
        />
      </div>

      {stats.reviews === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">No completed reviews yet.</Card>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          <Card className="p-5">
            <div className="mb-3 text-sm font-medium">Review outcomes</div>
            <VerdictBars verdicts={stats.verdicts} />
          </Card>
          {stats.dimensionAverages.length >= 3 && (
            <Card className="p-5">
              <div className="mb-3 text-sm font-medium">Average scores by dimension</div>
              <ScoreRadar scores={asScores} />
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
