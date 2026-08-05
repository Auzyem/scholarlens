'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/card'

interface Usage {
  plan: string
  manuscripts: { used: number; limit: number | null }
  reviewsThisMonth: { used: number; limit: number | null }
  resets: boolean
  exhausted: boolean
}

function Bar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const unlimited = limit === null
  const pct = unlimited ? 0 : Math.min(100, (used / Math.max(limit, 1)) * 100)
  const atCap = !unlimited && used >= limit
  const barColor = atCap ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-pr-teal'

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{unlimited ? `${used} used` : `${used} / ${limit}`}</span>
      </div>
      {!unlimited && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {atCap && (
        <Link href="/billing" className="mt-1 inline-block text-xs font-medium text-pr-teal hover:underline">
          At your limit — Upgrade
        </Link>
      )}
    </div>
  )
}

export function UsageCard() {
  const [usage, setUsage] = useState<Usage | null>(null)

  useEffect(() => {
    fetch('/api/billing/usage')
      .then((r) => r.json())
      .then((d) => setUsage(d.manuscripts ? d : null))
      .catch(() => setUsage(null))
  }, [])

  if (!usage) return null

  const oneTimeExhausted = usage.exhausted && !usage.resets

  return (
    <Card className="mb-6 p-5">
      <div className="mb-3 text-sm font-medium">
        {usage.resets ? 'Usage this month' : 'Usage'}
      </div>
      <div className="space-y-4">
        <Bar label="Manuscripts" used={usage.manuscripts.used} limit={usage.manuscripts.limit} />
        <Bar label="Reviews" used={usage.reviewsThisMonth.used} limit={usage.reviewsThisMonth.limit} />
      </div>
      {oneTimeExhausted && (
        <div className="mt-4 rounded-md border border-pr-teal/30 bg-pr-teal/5 p-3">
          <p className="text-sm font-medium text-pr-navy">You&apos;ve used your free reviews</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The free allowance is one-time and doesn&apos;t renew. Your account stays active and
            all your existing reviews remain available.
          </p>
          <Link
            href="/billing"
            className="mt-2 inline-block text-xs font-medium text-pr-teal hover:underline"
          >
            Upgrade to continue →
          </Link>
        </div>
      )}
    </Card>
  )
}
