import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'

// lib/stripe/sync imports the service-role client (which pulls in 'server-only')
// and the price resolver. Stub both: `hooks` lets each test drive what the price
// resolver returns and assert exactly which writes were attempted.
const hooks = vi.hoisted(() => ({
  resolved: null as null | { planId: string; interval: 'monthly' | 'annual' },
  userIdRow: null as null | { user_id: string },
  upsertCalls: [] as Record<string, unknown>[],
  updateCalls: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {}
      builder.select = () => builder
      builder.eq = () => builder
      builder.maybeSingle = async () => ({ data: hooks.userIdRow })
      builder.upsert = async (row: Record<string, unknown>) => {
        hooks.upsertCalls.push(row)
        return { error: null }
      }
      builder.update = (row: Record<string, unknown>) => {
        hooks.updateCalls.push(row)
        return { eq: async () => ({ error: null }) }
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/stripe/prices', () => ({
  resolvePlanFromPriceId: async () => hooks.resolved,
}))

import {
  subscriptionPeriodEnd,
  subscriptionPeriodStart,
  subscriptionIdFromInvoice,
  mapStatus,
  mapSubscriptionToRow,
  syncSubscriptionToDb,
  syncSubscriptionDeleted,
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
          current_period_start: 1785512713,
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
    current_period_start: 1697408000,
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

describe('subscriptionPeriodStart', () => {
  it('reads the period start from the subscription item (dahlia shape)', () => {
    expect(subscriptionPeriodStart(dahliaSubscription())).toBe(1785512713)
  })

  it('falls back to the legacy top-level field for older webhook API versions', () => {
    expect(subscriptionPeriodStart(legacySubscription())).toBe(1697408000)
  })

  it('returns null rather than NaN when neither shape carries a period', () => {
    // Quotas meter from this; null makes the gate fall back to the calendar
    // month, whereas NaN would produce an invalid window bound.
    const bare = { id: 'sub_bare', items: { data: [{ id: 'si', price: { id: 'p' } }] } } as unknown as Stripe.Subscription
    expect(subscriptionPeriodStart(bare)).toBeNull()
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
    expect(row.current_period_start).toBeNull()
  })

  it('records the period start the quota window is anchored to', () => {
    const row = mapSubscriptionToRow(dahliaSubscription(), {
      userId: 'user-1',
      planId: 'starter',
      interval: 'monthly',
    })
    expect(row.current_period_start).toBe(new Date(1785512713 * 1000).toISOString())
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

/**
 * This Stripe account is shared with another application (agency101.dev), whose
 * webhook endpoint and ours both receive the whole account's event stream —
 * Stripe has no per-application event routing. So our sync must decide for itself
 * whether a subscription is ours, and the test of ownership is the price: only
 * subscriptions priced with one of OUR plan prices may touch our data.
 */
describe('foreign-subscription isolation', () => {
  beforeEach(() => {
    hooks.resolved = null
    hooks.userIdRow = null
    hooks.upsertCalls = []
    hooks.updateCalls = []
  })

  const foreign = {
    id: 'sub_agency101',
    status: 'active',
    customer: 'cus_shared',
    cancel_at_period_end: false,
    // No metadata.supabase_user_id — but the customer id DOES match one of our
    // rows, which is how a shared customer used to slip through.
    metadata: {},
    items: { data: [{ id: 'si_x', current_period_end: 1788104713, price: { id: 'price_someone_elses' } }] },
  } as unknown as Stripe.Subscription

  const ours = dahliaSubscription()

  it('never writes for a subscription priced outside our plans', async () => {
    hooks.resolved = null // price does not resolve to any ScholarLens plan
    hooks.userIdRow = { user_id: 'our-paying-user' } // customer id collides with ours
    const result = await syncSubscriptionToDb(foreign)
    expect(result).toEqual({ synced: false, reason: 'foreign_price' })
    expect(hooks.upsertCalls).toHaveLength(0)
  })

  it('does not downgrade our user to free when the price is unknown', async () => {
    // Regression: an unresolvable price used to fall back to plan_id 'free',
    // which would strip a paying subscriber of the plan they had paid for.
    hooks.resolved = null
    hooks.userIdRow = { user_id: 'our-paying-user' }
    await syncSubscriptionToDb(foreign)
    expect(hooks.upsertCalls.map(r => r.plan_id)).not.toContain('free')
  })

  it('still syncs a subscription priced with one of our plans', async () => {
    hooks.resolved = { planId: 'starter', interval: 'monthly' }
    const result = await syncSubscriptionToDb(ours)
    expect(result).toMatchObject({ synced: true, userId: 'user-1', planId: 'starter' })
    expect(hooks.upsertCalls).toHaveLength(1)
    expect(hooks.upsertCalls[0]).toMatchObject({ plan_id: 'starter', stripe_subscription_id: 'sub_123' })
  })

  it('resolves the user from the recorded customer id when metadata is absent', async () => {
    hooks.resolved = { planId: 'pro', interval: 'annual' }
    hooks.userIdRow = { user_id: 'user-from-customer' }
    const noMeta = { ...ours, metadata: {} } as unknown as Stripe.Subscription
    const result = await syncSubscriptionToDb(noMeta)
    expect(result).toMatchObject({ synced: true, userId: 'user-from-customer' })
  })

  it('does not downgrade anyone when a foreign subscription is deleted', async () => {
    hooks.resolved = null
    hooks.userIdRow = { user_id: 'our-paying-user' }
    const result = await syncSubscriptionDeleted(foreign)
    expect(result).toEqual({ synced: false, reason: 'foreign_price' })
    expect(hooks.updateCalls).toHaveLength(0)
  })

  it('downgrades to free when OUR subscription is deleted', async () => {
    hooks.resolved = { planId: 'starter', interval: 'monthly' }
    const result = await syncSubscriptionDeleted(ours)
    expect(result).toMatchObject({ synced: true, planId: 'free' })
    expect(hooks.updateCalls).toHaveLength(1)
    expect(hooks.updateCalls[0]).toMatchObject({ plan_id: 'free', status: 'free' })
  })
})
