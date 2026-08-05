'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

// The API's 403 is the authoritative gate; this only saves the user a wasted
// click. It therefore renders the normal buttons whenever usage is unknown.
export function DashboardActions() {
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    fetch('/api/billing/usage')
      .then((r) => r.json())
      .then((d) => setBlocked(Boolean(d?.exhausted) && d?.resets === false))
      .catch(() => setBlocked(false))
  }, [])

  if (blocked) {
    return (
      <div className="flex flex-wrap items-center gap-2.5">
        <Link href="/billing"><Button>Upgrade to continue</Button></Link>
        <Link href="/manuscripts">
          <Button variant="outline">View past reviews</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2.5">
      <Link href="/manuscripts/new"><Button>New review</Button></Link>
      <Link href="/manuscripts/re-review">
        <Button variant="outline">Re-Review</Button>
      </Link>
    </div>
  )
}
