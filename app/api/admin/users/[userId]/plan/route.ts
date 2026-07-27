import { NextRequest, NextResponse } from 'next/server'
import { requirePermission, permissionErrorResponse } from '@/lib/admin/permissions'
import { createAdminClient } from '@/lib/supabase/admin'

const VALID_PLANS = ['free', 'starter', 'pro', 'team']

// Manual plan grant — used for the Team plan (an enterprise/academic licence
// sold off-platform, never through Stripe checkout) and for support overrides.
// Note: if the user later completes a real Stripe checkout or has an existing
// subscription that renews, the webhook's syncSubscription will overwrite this
// with whatever Stripe reports — this route only sets the current state.
export async function PUT(request: NextRequest, { params }: { params: { userId: string } }) {
  try {
    await requirePermission('billing.edit_plans')
    const { planId } = (await request.json()) as { planId: string }
    if (!VALID_PLANS.includes(planId)) {
      return NextResponse.json({ error: `Invalid plan: ${planId}` }, { status: 400 })
    }

    const admin = createAdminClient()
    const { error } = await admin
      .from('subscriptions')
      .upsert(
        {
          user_id: params.userId,
          plan_id: planId,
          status: planId === 'free' ? 'free' : 'active',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (error) {
    return permissionErrorResponse(error)
  }
}
