import { NextResponse } from 'next/server'
import { requirePermission, permissionErrorResponse } from '@/lib/admin/permissions'
import { stripe } from '@/lib/stripe/client'
import { syncSubscriptionToDb } from '@/lib/stripe/sync'
import type Stripe from 'stripe'

const LIVE: Stripe.Subscription.Status[] = ['active', 'trialing', 'past_due', 'unpaid']

/**
 * Re-read every live subscription from Stripe and make the database agree.
 *
 * This is the remedy for entitlement drift: if webhook delivery is ever broken —
 * wrong events enabled on the endpoint, a stale signing secret, a handler error —
 * customers who paid in the meantime stay on their old plan until something
 * re-reads Stripe. Idempotent, so it is safe to run repeatedly.
 */
export async function POST() {
  try {
    await requirePermission('billing.edit_plans')

    let scanned = 0
    let unmatched = 0
    // Subscriptions belonging to another application on this shared Stripe
    // account — expected, and not a problem worth surfacing as a failure.
    let foreign = 0
    const synced: { userId: string; planId: string; subscriptionId: string }[] = []

    for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
      if (!LIVE.includes(sub.status)) continue
      scanned++
      const result = await syncSubscriptionToDb(sub)
      if (result.synced && result.userId && result.planId) {
        synced.push({ userId: result.userId, planId: result.planId, subscriptionId: sub.id })
      } else if (result.reason === 'foreign_price') {
        foreign++
      } else {
        unmatched++
      }
    }

    return NextResponse.json({ scanned, syncedCount: synced.length, foreign, unmatched, synced })
  } catch (error) {
    return permissionErrorResponse(error)
  }
}
