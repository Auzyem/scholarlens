import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { UserStatsPanel } from '@/components/stats/UserStatsPanel'

export default async function AdminUserStatsPage({ params }: { params: { userId: string } }) {
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('email, full_name')
    .eq('id', params.userId)
    .single()

  return (
    <div>
      <Link href="/admin" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to admin
      </Link>
      <h1 className="mb-1 text-2xl font-semibold">{profile?.full_name ?? 'User'}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{profile?.email ?? params.userId}</p>
      <UserStatsPanel userId={params.userId} />
    </div>
  )
}
