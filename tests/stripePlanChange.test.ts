import { describe, it, expect } from 'vitest'
import { prorationStrategy } from '@/lib/stripe/planChange'

describe('prorationStrategy', () => {
  it('collects immediately when the change owes money', () => {
    // Starter -> Pro mid-cycle: credit unused Starter, charge remaining Pro.
    expect(prorationStrategy(3490)).toEqual({
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    })
  })

  it('carries the credit forward when the change is a downgrade', () => {
    // Pro -> Starter mid-cycle nets a credit. Invoicing a negative amount now
    // just produces a confusing negative invoice; put it on the next invoice.
    expect(prorationStrategy(-3489)).toEqual({ proration_behavior: 'create_prorations' })
  })

  it('carries forward when nothing is due (an exactly even swap)', () => {
    expect(prorationStrategy(0)).toEqual({ proration_behavior: 'create_prorations' })
  })

  it('never sets payment_behavior on the credit path', () => {
    // error_if_incomplete exists to stop us granting an unpaid plan. There is
    // nothing to collect on a credit, so asserting payment would be wrong.
    expect(prorationStrategy(-1)).not.toHaveProperty('payment_behavior')
  })

  it('treats an unknown amount as money owed, so we never grant an unpaid plan', () => {
    // If the preview could not be computed we must fail closed: collect and let
    // Stripe reject the change rather than upgrading someone for free.
    expect(prorationStrategy(null)).toEqual({
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    })
  })

  it('is decided by the amount due, not by the price tier', () => {
    // A cheaper monthly -> pricier annual still owes money; a pricier monthly ->
    // cheaper-per-month annual can still owe money. Only the invoice decides,
    // which is why this takes an amount rather than two prices.
    expect(prorationStrategy(48000).proration_behavior).toBe('always_invoice')
    expect(prorationStrategy(-48000).proration_behavior).toBe('create_prorations')
  })
})
