import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { getActivePriceId } from '@/lib/stripe/prices'
import { syncSubscriptionToDb } from '@/lib/stripe/sync'
import { prorationStrategy } from '@/lib/stripe/planChange'
import type Stripe from 'stripe'

// Statuses whose subscription can be re-priced in place. Anything else (canceled,
// incomplete_expired) is finished — that customer needs a fresh checkout.
const SWITCHABLE: Stripe.Subscription.Status[] = ['active', 'trialing', 'past_due', 'unpaid']

/**
 * The customer's live subscription, if any. Stripe is the source of truth here
 * rather than our own stripe_subscription_id, which may be stale (or null) if a
 * webhook was ever missed — and a stale read is exactly how you end up billing
 * someone twice.
 */
async function findSwitchableSubscription(customerId: string): Promise<Stripe.Subscription | null> {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
  const switchable = subs.data.filter((s) => SWITCHABLE.includes(s.status))
  return switchable.find((s) => s.status === 'active') ?? switchable[0] ?? null
}

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

  // Plan change for an existing subscriber: re-price the subscription they
  // already have. Opening a second Checkout Session (what this route used to do
  // for everyone) creates a SECOND parallel subscription in Stripe — the customer
  // is charged for both, the old one keeps renewing, and because our
  // subscriptions row is keyed by user_id only one of them is ever reflected.
  const existing = await findSwitchableSubscription(customerId)
  if (existing) {
    const item = existing.items.data[0]
    if (!item) {
      return NextResponse.json({ error: 'Subscription has no billable item' }, { status: 500 })
    }
    if (item.price?.id === priceId) {
      return NextResponse.json({ error: 'You are already on this plan' }, { status: 400 })
    }

    // Ask Stripe what this change actually invoices before choosing how to
    // prorate it — an upgrade must be collected now, a downgrade should credit
    // forward, and only the preview knows which this is (see planChange.ts).
    let amountDueNow: number | null = null
    try {
      const preview = await stripe.invoices.createPreview({
        customer: customerId,
        subscription: existing.id,
        subscription_details: {
          items: [{ id: item.id, price: priceId }],
          proration_behavior: 'always_invoice',
        },
      })
      amountDueNow = preview.amount_due
    } catch (previewError) {
      // Fail closed: prorationStrategy(null) collects rather than granting a plan
      // we could not price.
      console.warn(
        '[api/billing/checkout] proration preview failed; defaulting to collect-now:',
        previewError instanceof Error ? previewError.message : previewError,
      )
    }

    const updated = await stripe.subscriptions.update(existing.id, {
      items: [{ id: item.id, price: priceId }],
      ...prorationStrategy(amountDueNow),
      metadata: { supabase_user_id: user.id, plan_id: planId },
    })

    // Sync straight away instead of waiting on the webhook, so the plan is live
    // by the time the browser refreshes. The webhook re-syncs the same state.
    await syncSubscriptionToDb(updated)
    return NextResponse.json({ upgraded: true, plan: planId, interval })
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
    // A declined card on an in-place plan switch is the customer's problem to fix,
    // not a server fault — say so with 402 so the UI shows the decline reason.
    const type = (error as { type?: string })?.type
    if (type === 'StripeCardError') {
      return NextResponse.json({ error: message }, { status: 402 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
