import { NextResponse } from 'next/server'
import { requirePermission, permissionErrorResponse } from '@/lib/admin/permissions'
import { getUserStats } from '@/lib/stats/userStats'

export async function GET(_request: Request, { params }: { params: { userId: string } }) {
  try {
    await requirePermission('users.view')
    const stats = await getUserStats(params.userId)
    return NextResponse.json(stats)
  } catch (error) {
    return permissionErrorResponse(error)
  }
}
