import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { getActivePriceId } from '@/lib/stripe/prices'

export async function POST(request: NextRequest) {
  try {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { planId, interval = 'monthly' } = await request.json()
  if (planId === 'free') {
    return NextResponse.json({ error: 'Cannot checkout the free plan' }, { status: 400 })
  }

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .single()

  let customerId = sub?.stripe_customer_id ?? undefined

  if (!customerId) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', user.id)
      .single()

    const customer = await stripe.customers.create({
      email: profile?.email ?? user.email ?? undefined,
      name: profile?.full_name ?? undefined,
      metadata: { supabase_user_id: user.id },
    })
    customerId = customer.id
    await supabase.from('subscriptions').update({ stripe_customer_id: customerId }).eq('user_id', user.id)
  }

  let priceId: string
  try {
    priceId = await getActivePriceId(planId, interval as 'monthly' | 'annual')
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid plan' }, { status: 400 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/billing?canceled=true`,
    // No trial_period_days on any plan — every subscription bills immediately.
    subscription_data: {
      metadata: { supabase_user_id: user.id, plan_id: planId },
    },
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    customer_update: { address: 'auto' },
    metadata: { supabase_user_id: user.id, plan_id: planId, interval },
  })

  return NextResponse.json({ url: session.url })
  } catch (error: unknown) {
    console.error('[api/billing/checkout] error:', error)
    const message = error instanceof Error ? error.message : 'Checkout failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
