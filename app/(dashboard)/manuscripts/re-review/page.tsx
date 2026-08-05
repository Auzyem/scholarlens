'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { withCompletedReview, type ReReviewCandidate } from '@/lib/manuscripts/reviewed'

export default function ReReviewPage() {
  const router = useRouter()
  const [candidates, setCandidates] = useState<ReReviewCandidate[] | null>(null)

  useEffect(() => {
    fetch('/api/manuscripts?status=active&sort=updated_at')
      .then((r) => r.json())
      .then((d) => setCandidates(withCompletedReview(d.manuscripts ?? [])))
      .catch(() => setCandidates([]))
  }, [])

  return (
    <div>
      <Link
        href="/dashboard"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to dashboard
      </Link>

      <h1 className="mb-2 text-2xl font-semibold">Re-review a manuscript</h1>
      <p className="mb-5 text-muted-foreground">
        Pick a manuscript you&apos;ve already had reviewed. You&apos;ll upload the revised version,
        and the new review is compared against the previous one.
      </p>

      {candidates === null ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : candidates.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No completed reviews yet.{' '}
          <Link href="/manuscripts/new" className="text-pr-teal hover:underline">
            Start your first review
          </Link>
          .
        </div>
      ) : (
        <div className="space-y-2.5">
          {candidates.map((c) => (
            <Card key={c.id} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {c.reviewCount} review{c.reviewCount === 1 ? '' : 's'}
                  {c.lastScore !== null && ` · last score ${c.lastScore}/10`}
                  {c.lastReviewedAt &&
                    ` · ${new Date(c.lastReviewedAt).toLocaleDateString()}`}
                </p>
              </div>
              <Button size="sm" onClick={() => router.push(`/manuscripts/${c.id}/upload`)}>
                <RefreshCw className="h-3.5 w-3.5" /> Re-review
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
