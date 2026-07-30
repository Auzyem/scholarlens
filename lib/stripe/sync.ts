import type Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePlanFromPriceId } from '@/lib/stripe/prices'

/**
 * Single source of truth for "a Stripe subscription became X, make the database
 * agree". Used by the webhook AND by the in-app plan switch, so a customer's
 * entitlement lands the same way no matter which path observed the payment.
 *
 * Everything here is defensive about Stripe object shapes on purpose: the fields
 * that describe *when* a subscription renews have moved twice across API
 * versions, and webhook payloads arrive shaped by the endpoint's configured API
 * version (which can be years older than the SDK we call out with).
 */

type Interval = 'monthly' | 'annual'
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled'

export interface SubscriptionRow {
  user_id: string
  plan_id: string
  status: SubscriptionStatus
  stripe_customer_id: string | null
  stripe_subscription_id: string
  stripe_price_id: string
  billing_interval: Interval
  current_period_start: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  updated_at: string
}

/**
 * The billing period moved off the subscription and onto each subscription item
 * in API version 2025-03-31.basil. stripe-node v22 defaults to 2026-05-27.dahlia,
 * where `subscription.current_period_end` is simply absent — reading it yields
 * undefined, and `new Date(undefined * 1000).toISOString()` throws RangeError.
 * Older webhook endpoints still deliver the top-level field, so accept both and
 * return null (never NaN) when neither is present.
 */
export function subscriptionPeriodEnd(subscription: Stripe.Subscription): number | null {
  const item = subscription.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number | null })
    | undefined
  if (typeof item?.current_period_end === 'number') return item.current_period_end

  const legacy = (subscription as Stripe.Subscription & { current_period_end?: number | null })
    .current_period_end
  return typeof legacy === 'number' ? legacy : null
}

/**
 * The period *start*, resolved exactly like `subscriptionPeriodEnd` above and
 * for the same reason — it moved onto the subscription item in the same API
 * version. Usage quotas are metered from this, so returning null (and letting
 * the caller fall back to the calendar month) is the only safe miss.
 */
export function subscriptionPeriodStart(subscription: Stripe.Subscription): number | null {
  const item = subscription.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_start?: number | null })
    | undefined
  if (typeof item?.current_period_start === 'number') return item.current_period_start

  const legacy = (subscription as Stripe.Subscription & { current_period_start?: number | null })
    .current_period_start
  return typeof legacy === 'number' ? legacy : null
}

/**
 * `invoice.subscription` was likewise removed in basil in favour of
 * `invoice.parent.subscription_details.subscription`. Read whichever the
 * incoming payload uses; either can be a bare id or an expanded object.
 */
export function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const asId = (value: unknown): string | null => {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'id' in value) {
      const id = (value as { id?: unknown }).id
      return typeof id === 'string' ? id : null
    }
    return null
  }

  const legacy = asId((invoice as { subscription?: unknown }).subscription)
  if (legacy) return legacy

  const parent = (invoice as {
    parent?: { subscription_details?: { subscription?: unknown } }
  }).parent
  return asId(parent?.subscription_details?.subscription)
}

/** Collapse Stripe's status set onto the values `subscriptions.status` accepts. */
export function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  // Trials are no longer offered; if one is ever applied out-of-band, the
  // customer still has access, so record it as active.
  if (status === 'active' || status === 'trialing') return 'active'
  if (status === 'canceled') return 'canceled'
  return 'past_due'
}

function customerId(subscription: Stripe.Subscription): string | null {
  const c = subscription.customer
  if (typeof c === 'string') return c
  return c && typeof c === 'object' && 'id' in c ? c.id : null
}

/** Build the `subscriptions` row for a Stripe subscription. Pure — easy to test. */
export function mapSubscriptionToRow(
  subscription: Stripe.Subscription,
  opts: { userId: string; planId: string; interval: Interval; now?: Date },
): SubscriptionRow {
  const periodEnd = subscriptionPeriodEnd(subscription)
  const periodStart = subscriptionPeriodStart(subscription)
  return {
    user_id: opts.userId,
    plan_id: opts.planId,
    status: mapStatus(subscription.status),
    stripe_customer_id: customerId(subscription),
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.items?.data?.[0]?.price?.id ?? '',
    billing_interval: opts.interval,
    current_period_start: periodStart === null ? null : new Date(periodStart * 1000).toISOString(),
    current_period_end: periodEnd === null ? null : new Date(periodEnd * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    updated_at: (opts.now ?? new Date()).toISOString(),
  }
}

/**
 * Which user does this subscription belong to? Our checkout stamps
 * `supabase_user_id` into subscription metadata, but subscriptions created out of
 * band (the Stripe dashboard, or an import) carry none. Fall back to the Stripe
 * customer id we recorded at checkout time so the customer still gets what they
 * paid for instead of being silently skipped.
 */
export async function resolveUserId(subscription: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = subscription.metadata?.supabase_user_id
  if (fromMetadata) return fromMetadata

  const cus = customerId(subscription)
  if (!cus) return null

  const admin = createAdminClient()
  const { data } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', cus)
    .maybeSingle()
  return (data?.user_id as string | undefined) ?? null
}

export interface SyncResult {
  synced: boolean
  reason?: 'no_user' | 'foreign_price' | 'ok'
  userId?: string
  planId?: string
}

/**
 * Is this subscription ours at all?
 *
 * This Stripe account is shared with another application, and a Stripe webhook
 * endpoint receives every event of its subscribed types generated anywhere in the
 * account — there is no per-application routing. So ownership has to be decided
 * here, and the test is the price: a subscription counts as ours only when its
 * price resolves to one of our plans (via the plan_prices history table, which
 * includes archived prices, or the STRIPE_PRICE_* env fallback).
 *
 * Returns null for a subscription that belongs to another application.
 */
async function resolveOwnPlan(
  subscription: Stripe.Subscription,
): Promise<{ planId: string; interval: Interval } | null> {
  const priceId = subscription.items?.data?.[0]?.price?.id ?? ''
  const resolved = await resolvePlanFromPriceId(priceId)
  if (!resolved) {
    console.warn(
      `[stripe sync] subscription ${subscription.id} is priced with ${priceId || '(no price)'}, ` +
      `which is not one of our plan prices — ignoring it (this Stripe account is shared with ` +
      `other applications). If this IS one of ours, its price is missing from plan_prices.`,
    )
    return null
  }
  return resolved
}

/**
 * Write the subscription's current state to the database. Throws on a failed
 * write so the caller can surface a 500 and let Stripe retry — a swallowed write
 * error here means a paying customer silently stays on their old plan.
 */
export async function syncSubscriptionToDb(subscription: Stripe.Subscription): Promise<SyncResult> {
  // Ownership first: never let another application's subscription reach our table.
  // This also protects the customer-id fallback below — a shared Stripe customer
  // used to be enough to overwrite one of our users, and an unresolvable price
  // used to be written as plan_id 'free', stripping a paying subscriber's plan.
  const resolved = await resolveOwnPlan(subscription)
  if (!resolved) return { synced: false, reason: 'foreign_price' }

  const userId = await resolveUserId(subscription)
  if (!userId) {
    console.warn(
      `[stripe sync] subscription ${subscription.id} has no supabase_user_id metadata and no ` +
      `matching stripe_customer_id row; skipping`,
    )
    return { synced: false, reason: 'no_user' }
  }

  const row = mapSubscriptionToRow(subscription, {
    userId,
    planId: resolved.planId,
    interval: resolved.interval,
  })

  const admin = createAdminClient()
  const { error } = await admin.from('subscriptions').upsert(row, { onConflict: 'user_id' })
  if (error) {
    throw new Error(
      `[stripe sync] failed to write subscription ${subscription.id} for user ${userId}: ${error.message}`,
    )
  }

  return { synced: true, reason: 'ok', userId, planId: row.plan_id }
}

/** A subscription ending returns the user to the free plan. */
export async function syncSubscriptionDeleted(subscription: Stripe.Subscription): Promise<SyncResult> {
  // Same ownership gate as the upsert path: another application cancelling a
  // subscription for a customer we happen to share must not downgrade our user.
  if (!(await resolveOwnPlan(subscription))) return { synced: false, reason: 'foreign_price' }

  const userId = await resolveUserId(subscription)
  if (!userId) return { synced: false, reason: 'no_user' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('subscriptions')
    .update({
      plan_id: 'free',
      status: 'free',
      stripe_subscription_id: null,
      stripe_price_id: null,
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
  if (error) {
    throw new Error(
      `[stripe sync] failed to downgrade user ${userId} after subscription ${subscription.id} ended: ${error.message}`,
    )
  }
  return { synced: true, reason: 'ok', userId, planId: 'free' }
}
