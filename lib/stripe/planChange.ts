import type Stripe from 'stripe'

/**
 * How to prorate an in-place plan change.
 *
 * The decision is made from the amount the change would actually invoice, NOT by
 * comparing the two prices. A raw price comparison is wrong in several real
 * cases: a cheaper monthly plan moving to a pricier annual one owes money, a
 * pricier monthly plan moving to a lower-per-month annual one can also owe money,
 * and how far through the billing period the customer is changes the sign. Only
 * the invoice preview knows.
 *
 * - Money owed  → invoice and collect it now, and fail the change outright rather
 *   than granting a plan that was not paid for.
 * - Credit due  → put the proration on the next invoice. Invoicing a negative
 *   amount immediately produces a confusing negative invoice; carrying it forward
 *   simply reduces (often zeroes) the next renewal.
 *
 * `amountDueNow` is in the smallest currency unit. Pass null when the preview
 * could not be computed — that fails closed onto the collect-now path.
 */
export function prorationStrategy(amountDueNow: number | null): {
  proration_behavior: Stripe.SubscriptionUpdateParams.ProrationBehavior
  payment_behavior?: 'error_if_incomplete'
} {
  if (amountDueNow === null || amountDueNow > 0) {
    return { proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' }
  }
  return { proration_behavior: 'create_prorations' }
}
