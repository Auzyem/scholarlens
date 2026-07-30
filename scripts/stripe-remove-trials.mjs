#!/usr/bin/env node
/**
 * Audits (and optionally clears) every remaining free-trial configuration in
 * Stripe. ScholarLens no longer offers a trial on any plan — the checkout route
 * stopped sending `trial_period_days`, so new subscriptions bill immediately —
 * but three things live only in Stripe and need checking:
 *
 *   1. Prices with `recurring.trial_period_days` set. A price's recurring block
 *      is immutable, so these can't be patched: the fix is to create a
 *      replacement price (admin console → sync price) and archive the old one.
 *      Reported, never auto-changed.
 *   2. Payment Links carrying `subscription_data.trial_period_days`. These are
 *      updatable and are cleared with --apply.
 *   3. Subscriptions currently in `trialing`. With --apply their trial is ended
 *      immediately (`trial_end: 'now'`), which makes Stripe invoice the customer
 *      right away. This is a real billing action on real customers — hence the
 *      dry run default.
 *
 * Run:  node scripts/stripe-remove-trials.mjs          (dry run — reports only)
 *       node scripts/stripe-remove-trials.mjs --apply   (makes the changes)
 * (No secrets are printed — only non-secret Stripe object IDs.)
 */
import Stripe from 'stripe'
import { readFileSync } from 'node:fs'

// Load .env.local (KEY=VALUE) without a dependency; existing process.env wins.
try {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, k, raw] = m
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^["']|["']$/g, '')
  }
} catch {
  // no .env.local — fall back to the ambient environment
}

const APPLY = process.argv.includes('--apply')

const key = process.env.STRIPE_SECRET_KEY
if (!key || key.includes('placeholder')) {
  console.error('✗ STRIPE_SECRET_KEY is missing or still a placeholder in .env.local')
  process.exit(1)
}
const mode = key.startsWith('sk_live') ? 'live' : 'test'
console.log(`Stripe secret key mode: ${mode}`)
console.log(APPLY ? 'Mode: APPLY — changes will be written to Stripe\n' : 'Mode: dry run — nothing will be changed\n')

const stripe = new Stripe(key)

let findings = 0

async function auditPrices() {
  console.log('— Prices with a built-in trial —')
  let found = 0
  for await (const price of stripe.prices.list({ limit: 100, active: true, expand: ['data.product'] })) {
    const days = price.recurring?.trial_period_days
    if (!days) continue
    found++
    findings++
    const productName = typeof price.product === 'object' && price.product && 'name' in price.product
      ? price.product.name
      : price.product
    console.log(`✗ ${price.id} (${productName}) has recurring.trial_period_days = ${days}`)
    console.log('    A price\'s recurring block is immutable. Create a replacement price without a')
    console.log('    trial (admin console → sync price) and archive this one.')
  }
  if (!found) console.log('✓ none')
  console.log()
}

async function auditPaymentLinks() {
  console.log('— Payment Links with a trial —')
  let found = 0
  for await (const link of stripe.paymentLinks.list({ limit: 100 })) {
    const days = link.subscription_data?.trial_period_days
    if (!days) continue
    found++
    findings++
    console.log(`✗ ${link.id} sets subscription_data.trial_period_days = ${days}`)
    if (APPLY) {
      await stripe.paymentLinks.update(link.id, { subscription_data: { trial_period_days: '' } })
      console.log('    → cleared')
    }
  }
  if (!found) console.log('✓ none')
  console.log()
}

async function auditSubscriptions() {
  console.log('— Subscriptions currently in a trial —')
  let found = 0
  for await (const sub of stripe.subscriptions.list({ status: 'trialing', limit: 100 })) {
    found++
    findings++
    const ends = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : 'unknown'
    console.log(`✗ ${sub.id} (customer ${sub.customer}) trialing until ${ends}`)
    if (APPLY) {
      await stripe.subscriptions.update(sub.id, { trial_end: 'now', proration_behavior: 'none' })
      console.log('    → trial ended now; Stripe will invoice immediately')
    }
  }
  if (!found) console.log('✓ none')
  console.log()
}

async function main() {
  await auditPrices()
  await auditPaymentLinks()
  await auditSubscriptions()

  if (findings === 0) {
    console.log('✓ No trial configuration left in Stripe.')
  } else if (APPLY) {
    console.log(`Done — ${findings} finding(s) processed (price-level trials, if any, still need a replacement price).`)
  } else {
    console.log(`${findings} finding(s). Re-run with --apply to clear the ones that can be changed automatically.`)
  }
}

main().catch((err) => {
  console.error('✗ stripe-remove-trials failed:', err.message)
  process.exit(1)
})
