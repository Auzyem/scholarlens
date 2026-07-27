import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUserStats } from '@/lib/stats/userStats'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const stats = await getUserStats(user.id)
    return NextResponse.json(stats)
  } catch (error: unknown) {
    console.error('[api/stats/me] error:', error)
    const message = error instanceof Error ? error.message : 'Failed to load stats'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
