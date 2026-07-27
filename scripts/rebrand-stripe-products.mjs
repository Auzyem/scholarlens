#!/usr/bin/env node
/**
 * One-off: rename the live Stripe products from "PeerReady <Plan>" to
 * "ScholarLens <Plan>" and add metadata.scholarlens_plan (kept alongside the
 * legacy peerready_plan key so scripts/stripe-setup.mjs's idempotent lookup
 * keeps matching either key). Renaming a Product's display name does not
 * touch its Prices, active subscriptions, or amounts — Stripe Checkout just
 * starts showing the new name on the next session.
 *
 * Run:  node scripts/rebrand-stripe-products.mjs
 */
import Stripe from 'stripe'
import { readFileSync } from 'node:fs'

try {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, k, raw] = m
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^["']|["']$/g, '')
  }
} catch {
  // fall back to ambient environment
}

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('✗ STRIPE_SECRET_KEY is not set.')
  process.exit(1)
}
const mode = key.startsWith('sk_live') ? 'LIVE' : 'test'
console.log(`Stripe mode: ${mode}\n`)

const stripe = new Stripe(key)

const RENAME = {
  starter: 'ScholarLens Starter',
  pro: 'ScholarLens Pro',
  team: 'ScholarLens Team',
}

async function main() {
  for await (const product of stripe.products.list({ limit: 100 })) {
    const planId = product.metadata?.peerready_plan ?? product.metadata?.scholarlens_plan
    if (!planId || !RENAME[planId]) continue
    const newName = RENAME[planId]
    if (product.name === newName && product.metadata?.scholarlens_plan === planId) {
      console.log(`• ${planId}: already "${newName}" with scholarlens_plan metadata — skipping`)
      continue
    }
    const updated = await stripe.products.update(product.id, {
      name: newName,
      metadata: { ...product.metadata, scholarlens_plan: planId },
    })
    console.log(`✓ ${product.id}: "${product.name}" → "${updated.name}"`)
  }
  console.log('\nDone. New Stripe Checkout sessions will show the ScholarLens product names immediately.')
}

main().catch((err) => {
  console.error('✗ Rebrand failed:', err.message)
  process.exit(1)
})
