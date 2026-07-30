import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe/client'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  subscriptionIdFromInvoice,
  syncSubscriptionToDb,
  syncSubscriptionDeleted,
} from '@/lib/stripe/sync'
import type Stripe from 'stripe'

/**
 * Events we act on. Keep this list in sync with the endpoint's enabled events in
 * the Stripe dashboard — an event Stripe isn't configured to send is an event
 * that can never upgrade anybody, however correct this handler is.
 */
async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.mode === 'subscription' && session.subscription) {
        const id = typeof session.subscription === 'string' ? session.subscription : session.subscription.id
        await syncSubscriptionToDb(await stripe.subscriptions.retrieve(id))
      }
      break
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.resumed':
      await syncSubscriptionToDb(event.data.object as Stripe.Subscription)
      break

    case 'customer.subscription.deleted':
      await syncSubscriptionDeleted(event.data.object as Stripe.Subscription)
      break

    // Money actually moved (first charge, renewal, or a proration invoice from a
    // plan switch) — re-read the subscription so entitlement follows payment even
    // if the subscription.* event was missed or arrived out of order.
    case 'invoice.payment_succeeded':
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const subId = subscriptionIdFromInvoice(event.data.object as Stripe.Invoice)
      if (subId) {
        await syncSubscriptionToDb(await stripe.subscriptions.retrieve(subId))
      }
      break
    }

    default:
      break
  }
}

export async function POST(request: NextRequest) {
  const body = await request.text()
  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET ?? '')
  } catch (err) {
    console.error('Webhook signature verification failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const supabaseAdmin = createAdminClient()

  // Idempotency — insert first and let the unique constraint on stripe_event_id
  // arbitrate. This closes the concurrent-retry window a select-then-insert leaves
  // open (Stripe retries are common). A unique violation (23505) means we've already
  // processed this event, so we skip the handlers.
  const { error: insertError } = await supabaseAdmin.from('billing_events').insert({
    stripe_event_id: event.id,
    event_type: event.type,
    payload: event.data.object as unknown as Record<string, unknown>,
    user_id: (event.data.object as { metadata?: { supabase_user_id?: string } })?.metadata?.supabase_user_id ?? null,
  })
  if (insertError) {
    if (insertError.code === '23505') return NextResponse.json({ ok: true, skipped: true })
    // Any other insert failure is unexpected — log and stop before double-processing.
    console.error('[stripe webhook] failed to record event:', insertError.message)
    return NextResponse.json({ error: 'Failed to record event' }, { status: 500 })
  }

  try {
    await handleEvent(event)
  } catch (err) {
    // The marker row above makes retries idempotent, but it also makes them
    // *skippable* — so a handler that threw would be dropped forever, leaving a
    // paying customer on their old plan. Remove the marker so Stripe's retry
    // reprocesses this event instead of short-circuiting on 23505.
    const { error: cleanupError } = await supabaseAdmin
      .from('billing_events')
      .delete()
      .eq('stripe_event_id', event.id)
    if (cleanupError) {
      console.error(
        `[stripe webhook] event ${event.id} failed AND its marker could not be cleared ` +
        `(${cleanupError.message}) — it will not be retried; reconcile manually`,
      )
    }
    console.error(
      `[stripe webhook] handler for ${event.type} (${event.id}) failed:`,
      err instanceof Error ? err.message : err,
    )
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
