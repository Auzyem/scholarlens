import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkManuscriptLimit, checkReviewLimit } from '@/lib/plan/gates'

export const dynamic = 'force-dynamic'

// Single source of truth for the dashboard usage card and the billing page's
// usage summary — one round trip covers everything both surfaces need.
export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [manuscripts, reviewsThisMonth, { data: sub }, { count: apiKeyCount }] = await Promise.all([
      checkManuscriptLimit(user.id),
      checkReviewLimit(user.id),
      supabase
        .from('subscriptions')
        .select('plan_id, plans(adversarial_access, journal_matching, pdf_reports, api_access, max_api_keys)')
        .eq('user_id', user.id)
        .single(),
      supabase.from('api_keys').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('revoked', false),
    ])

    const plan = sub?.plans as unknown as {
      adversarial_access: boolean
      journal_matching: boolean
      pdf_reports: boolean
      api_access: boolean
      max_api_keys: number | null
    } | null

    // Infinity (unlimited / super_admin) isn't valid JSON — null means unlimited on the wire.
    const toWireLimit = (n: number) => (Number.isFinite(n) ? n : null)

    return NextResponse.json({
      plan: sub?.plan_id ?? 'free',
      manuscripts: { used: manuscripts.used, limit: toWireLimit(manuscripts.limit) },
      reviewsThisMonth: { used: reviewsThisMonth.used, limit: toWireLimit(reviewsThisMonth.limit) },
      features: {
        adversarial_access: plan?.adversarial_access ?? false,
        journal_matching: plan?.journal_matching ?? false,
        pdf_reports: plan?.pdf_reports ?? false,
      },
      apiKeys: { used: apiKeyCount ?? 0, limit: plan?.max_api_keys ?? 0 },
    })
  } catch (error: unknown) {
    console.error('[api/billing/usage] error:', error)
    const message = error instanceof Error ? error.message : 'Failed to load usage'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
