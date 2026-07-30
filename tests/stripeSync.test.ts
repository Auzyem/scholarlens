import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'

// lib/stripe/sync imports the service-role client (which pulls in 'server-only');
// stub it so the pure shape-normalising helpers can be tested in isolation.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: vi.fn() }) }))

import {
  subscriptionPeriodEnd,
  subscriptionIdFromInvoice,
  mapStatus,
  mapSubscriptionToRow,
} from '@/lib/stripe/sync'

/**
 * The shape returned by stripe-node v22 (API 2026-05-27.dahlia): the billing
 * period lives on the subscription ITEM and there is no top-level
 * current_period_end at all.
 */
function dahliaSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    customer: 'cus_123',
    cancel_at_period_end: false,
    metadata: { supabase_user_id: 'user-1', plan_id: 'starter' },
    items: {
      data: [
        {
          id: 'si_123',
          current_period_end: 1788104713,
          price: { id: 'price_starter_monthly' },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription
}

/** The shape older webhook endpoints still deliver (API 2022-11-15). */
function legacySubscription() {
  return {
    id: 'sub_legacy',
    status: 'active',
    customer: 'cus_legacy',
    cancel_at_period_end: true,
    current_period_end: 1700000000,
    metadata: { supabase_user_id: 'user-2' },
    items: { data: [{ id: 'si_legacy', price: { id: 'price_pro_monthly' } }] },
  } as unknown as Stripe.Subscription
}

describe('subscriptionPeriodEnd', () => {
  it('reads the period from the subscription item (stripe-node v22 / dahlia shape)', () => {
    expect(subscriptionPeriodEnd(dahliaSubscription())).toBe(1788104713)
  })

  it('falls back to the legacy top-level field for older webhook API versions', () => {
    expect(subscriptionPeriodEnd(legacySubscription())).toBe(1700000000)
  })

  it('returns null rather than NaN when neither shape carries a period', () => {
    const bare = { id: 'sub_bare', items: { data: [{ id: 'si', price: { id: 'p' } }] } } as unknown as Stripe.Subscription
    expect(subscriptionPeriodEnd(bare)).toBeNull()
  })
})

describe('mapSubscriptionToRow', () => {
  it('produces a valid ISO period end for the v22 shape', () => {
    // Regression: the old webhook read subscription.current_period_end directly,
    // which is undefined on this shape. `new Date(undefined * 1000).toISOString()`
    // throws RangeError, so the whole sync aborted and the plan never updated.
    const row = mapSubscriptionToRow(dahliaSubscription(), {
      userId: 'user-1',
      planId: 'starter',
      interval: 'monthly',
      now: new Date('2026-07-30T16:00:00.000Z'),
    })
    expect(row.current_period_end).toBe(new Date(1788104713 * 1000).toISOString())
    expect(row).toMatchObject({
      user_id: 'user-1',
      plan_id: 'starter',
      status: 'active',
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_123',
      stripe_price_id: 'price_starter_monthly',
      billing_interval: 'monthly',
      cancel_at_period_end: false,
      updated_at: '2026-07-30T16:00:00.000Z',
    })
  })

  it('leaves current_period_end null when Stripe reports no period', () => {
    const bare = {
      id: 'sub_bare',
      status: 'active',
      customer: 'cus_bare',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si', price: { id: 'price_x' } }] },
    } as unknown as Stripe.Subscription
    const row = mapSubscriptionToRow(bare, { userId: 'u', planId: 'pro', interval: 'annual' })
    expect(row.current_period_end).toBeNull()
  })
})

describe('mapStatus', () => {
  it('maps active and trialing to active (no trials are offered any more)', () => {
    expect(mapStatus('active')).toBe('active')
    expect(mapStatus('trialing')).toBe('active')
  })

  it('maps canceled to canceled', () => {
    expect(mapStatus('canceled')).toBe('canceled')
  })

  it('maps every unpaid/incomplete state to past_due', () => {
    expect(mapStatus('past_due')).toBe('past_due')
    expect(mapStatus('unpaid')).toBe('past_due')
    expect(mapStatus('incomplete')).toBe('past_due')
  })
})

describe('subscriptionIdFromInvoice', () => {
  it('reads the legacy top-level invoice.subscription', () => {
    const invoice = { id: 'in_1', subscription: 'sub_legacy' } as unknown as Stripe.Invoice
    expect(subscriptionIdFromInvoice(invoice)).toBe('sub_legacy')
  })

  it('reads the expanded object form', () => {
    const invoice = { id: 'in_2', subscription: { id: 'sub_expanded' } } as unknown as Stripe.Invoice
    expect(subscriptionIdFromInvoice(invoice)).toBe('sub_expanded')
  })

  it('reads the current parent.subscription_details shape', () => {
    const invoice = {
      id: 'in_3',
      parent: { subscription_details: { subscription: 'sub_parent' } },
    } as unknown as Stripe.Invoice
    expect(subscriptionIdFromInvoice(invoice)).toBe('sub_parent')
  })

  it('returns null for a one-off invoice with no subscription', () => {
    const invoice = { id: 'in_4' } as unknown as Stripe.Invoice
    expect(subscriptionIdFromInvoice(invoice)).toBeNull()
  })
})
