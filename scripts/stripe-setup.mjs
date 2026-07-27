#!/usr/bin/env node
/**
 * Idempotent Stripe setup for ScholarLens.
 *
 * Creates the Starter/Pro/Team products and their monthly + annual prices, then
 * prints the STRIPE_PRICE_* env block to paste into .env.local and Vercel.
 *
 * Run with your TEST-mode secret key (the key never leaves your machine):
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
 *
 * Safe to re-run: products are matched by metadata.scholarlens_plan and prices by
 * lookup_key, so nothing is duplicated. Prices are immutable in Stripe — to change
 * an amount, use the admin console's price sync (or archive the old price and
 * bump the lookup_key here).
 */
import Stripe from 'stripe'

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('✗ STRIPE_SECRET_KEY is not set.\n  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs')
  process.exit(1)
}
if (key.startsWith('sk_live')) {
  console.warn('⚠ This is a LIVE key. Use a test key (sk_test_...) unless you really mean to create live products.\n')
}

const stripe = new Stripe(key)

// Amounts in cents. `annual` is the total charged once per year (matches the billing page).
const PLANS = [
  { id: 'starter', name: 'ScholarLens Starter', monthly: 1200, annual: 9600 },
  { id: 'pro', name: 'ScholarLens Pro', monthly: 2900, annual: 22800 },
  { id: 'team', name: 'ScholarLens Team', monthly: 7900, annual: 70800 },
]

const INTERVALS = [
  { key: 'monthly', interval: 'month' },
  { key: 'annual', interval: 'year' },
]

const ENV_VAR = {
  starter_monthly: 'STRIPE_PRICE_STARTER_MONTHLY',
  starter_annual: 'STRIPE_PRICE_STARTER_ANNUAL',
  pro_monthly: 'STRIPE_PRICE_PRO_MONTHLY',
  pro_annual: 'STRIPE_PRICE_PRO_ANNUAL',
  team_monthly: 'STRIPE_PRICE_TEAM_MONTHLY',
  team_annual: 'STRIPE_PRICE_TEAM_ANNUAL',
}

async function findOrCreateProduct(plan) {
  // List + filter by metadata (avoids the Search API's indexing lag).
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.active && product.metadata?.scholarlens_plan === plan.id) {
      console.log(`• product ${plan.id}: reusing ${product.id}`)
      return product
    }
  }
  const created = await stripe.products.create({
    name: plan.name,
    metadata: { scholarlens_plan: plan.id },
  })
  console.log(`• product ${plan.id}: created ${created.id}`)
  return created
}

async function findOrCreatePrice(product, plan, iv) {
  const lookupKey = `pr_${plan.id}_${iv.key}`
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
  if (found.data[0]) {
    console.log(`    price ${lookupKey}: reusing ${found.data[0].id}`)
    return found.data[0]
  }
  const amount = plan[iv.key]
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: amount,
    recurring: { interval: iv.interval },
    lookup_key: lookupKey,
    metadata: { scholarlens_plan: plan.id, scholarlens_interval: iv.key },
  })
  console.log(`    price ${lookupKey}: created ${price.id} ($${(amount / 100).toFixed(2)}/${iv.interval})`)
  return price
}

async function main() {
  const envLines = []
  for (const plan of PLANS) {
    const product = await findOrCreateProduct(plan)
    for (const iv of INTERVALS) {
      const price = await findOrCreatePrice(product, plan, iv)
      envLines.push(`${ENV_VAR[`${plan.id}_${iv.key}`]}=${price.id}`)
    }
  }

  console.log('\n=== Paste these into .env.local and your Vercel env ===\n')
  console.log(envLines.join('\n'))
  console.log('\nAlso set (Stripe Dashboard → Developers → API keys):')
  console.log('  STRIPE_SECRET_KEY=sk_test_...')
  console.log('  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...')
  console.log('\n✓ Done — re-running is safe (idempotent).')
}

main().catch((err) => {
  console.error('✗ Stripe setup failed:', err.message)
  process.exit(1)
})
