#!/usr/bin/env node
/**
 * Verifies ScholarLens's Stripe wiring before you test a real checkout.
 *
 * Prices are admin-editable at runtime (the plan_prices table, synced via the
 * admin console's "sync price" action — see
 * docs/superpowers/specs/2026-06-04-admin-stripe-price-sync-design.md), so this
 * script does NOT hardcode expected amounts. Instead it reads the current
 * source of truth — the `plans` table's display price plus the active
 * `plan_prices` row (falling back to the STRIPE_PRICE_* env var pre-backfill,
 * exactly like lib/stripe/prices.ts's getActivePriceId) — and checks that each
 * resolves in Stripe to a price with the matching amount, currency, and
 * interval. A hardcoded EXPECT table would silently go stale the next time an
 * admin changes a price — this stays correct automatically.
 *
 * Run:  node scripts/stripe-verify.mjs
 * (No secrets are printed — only the non-secret price IDs.)
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

const key = process.env.STRIPE_SECRET_KEY
if (!key || key.includes('placeholder')) {
  console.error('✗ STRIPE_SECRET_KEY is missing or still a placeholder in .env.local')
  process.exit(1)
}
const mode = key.startsWith('sk_live') ? 'live' : 'test'
console.log(`Stripe secret key mode: ${mode}\n`)

const stripe = new Stripe(key)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceKey) {
  console.error('✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local')
  process.exit(1)
}

async function sb(path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  if (!res.ok) throw new Error(`Supabase REST ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// Mirrors lib/stripe/prices.ts monthlyCents / annualCents (the $X/mo → $X×12/yr convention).
const monthlyCents = (usd) => Math.round(usd * 100)
const annualCents = (usd) => Math.round(usd * 12 * 100)

const INTERVALS = [
  { key: 'monthly', stripeInterval: 'month', cents: monthlyCents, priceField: 'price_monthly_usd' },
  { key: 'annual', stripeInterval: 'year', cents: annualCents, priceField: 'price_annual_monthly_usd' },
]

let failures = 0

async function main() {
  const plans = await sb('plans?select=id,price_monthly_usd,price_annual_monthly_usd&id=neq.free')
  const planPrices = await sb('plan_prices?select=plan_id,interval,stripe_price_id,unit_amount&active=eq.true')

  for (const plan of plans) {
    for (const iv of INTERVALS) {
      const label = `${plan.id}_${iv.key}`
      const expectedAmount = iv.cents(plan[iv.priceField] ?? 0)
      const dbRow = planPrices.find((p) => p.plan_id === plan.id && p.interval === iv.key)
      const envKey = `STRIPE_PRICE_${plan.id.toUpperCase()}_${iv.key.toUpperCase()}`
      const priceId = dbRow?.stripe_price_id ?? process.env[envKey]
      const source = dbRow ? 'plan_prices' : 'env fallback'

      const problems = []
      if (!priceId) {
        problems.push(`no active plan_prices row and ${envKey} is unset`)
      } else {
        try {
          const price = await stripe.prices.retrieve(priceId)
          if (!price.active) problems.push('price is archived/inactive in Stripe')
          if (price.currency !== 'usd') problems.push(`currency ${price.currency}, expected usd`)
          if (price.unit_amount !== expectedAmount) {
            problems.push(`Stripe amount ${price.unit_amount}¢, but plans table implies ${expectedAmount}¢`)
          }
          if (price.recurring?.interval !== iv.stripeInterval) {
            problems.push(`interval ${price.recurring?.interval ?? 'none'}, expected ${iv.stripeInterval}`)
          }
        } catch (err) {
          problems.push(`retrieve failed in ${mode} mode — wrong mode or bad ID? (${err.message})`)
        }
      }

      if (problems.length === 0) {
        console.log(`✓ ${label} (${source}) → ${priceId} ($${(expectedAmount / 100).toFixed(2)}/${iv.stripeInterval})`)
      } else {
        failures += problems.length
        console.log(`✗ ${label} (${source}) = ${priceId ?? '(unresolved)'}`)
        for (const p of problems) console.log(`    - ${p}`)
      }
    }
  }

  console.log()

  const pub = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  if (!pub || pub.includes('...')) {
    failures++
    console.log('✗ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is unset/placeholder')
  } else if (!pub.startsWith('pk_')) {
    failures++
    console.log('✗ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY does not look like a publishable key (pk_…)')
  } else {
    const pubMode = pub.startsWith('pk_live') ? 'live' : 'test'
    if (pubMode !== mode) {
      failures++
      console.log(`✗ publishable key is ${pubMode} mode but secret key is ${mode} mode — they must match`)
    } else {
      console.log(`✓ publishable key present and in ${mode} mode`)
    }
  }

  const whsec = process.env.STRIPE_WEBHOOK_SECRET
  if (!whsec || whsec.includes('...')) {
    console.log('• STRIPE_WEBHOOK_SECRET not set yet — set it to the whsec_… that `stripe listen` prints (needed for webhook delivery).')
  } else if (!whsec.startsWith('whsec_')) {
    console.log('• STRIPE_WEBHOOK_SECRET does not look like a signing secret (whsec_…).')
  } else {
    console.log('✓ webhook signing secret present')
  }

  console.log()
  if (failures === 0) {
    console.log('✓ Wiring looks good — go run a test checkout.')
  } else {
    console.log(`✗ ${failures} problem(s) found.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('✗ stripe-verify failed:', err.message)
  process.exit(1)
})
