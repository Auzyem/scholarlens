import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { UsageCard } from '@/components/dashboard/UsageCard'

export default function DashboardPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Welcome to ScholarLens</h1>
      <p className="mb-4 text-muted-foreground">Upload a manuscript to get an AI peer review.</p>
      <Link href="/manuscripts/new"><Button>New review</Button></Link>
      <div className="mt-6 max-w-sm">
        <UsageCard />
      </div>
    </div>
  )
}
