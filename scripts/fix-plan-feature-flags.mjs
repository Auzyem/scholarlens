#!/usr/bin/env node
/**
 * One-off: align the live `plans` feature flags with what the marketing/billing
 * copy actually promises (see docs/superpowers/specs/2026-07-27-usage-metering-design.md).
 *
 * - adversarial_access: false for free + starter (was true for every plan —
 *   copy positions it as a Pro-only differentiator)
 * - pdf_reports: false for free (was true for every plan — copy positions it
 *   as a Starter+ differentiator)
 * - journal_matching is already correct (false free/starter, true pro/team) —
 *   not touched here.
 *
 * Run:  node scripts/fix-plan-feature-flags.mjs
 */
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local')
  process.exit(1)
}

async function patch(filter, body) {
  const res = await fetch(`${url}/rest/v1/plans?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${filter} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function main() {
  const a = await patch('id=in.(free,starter)', { adversarial_access: false })
  console.log(`✓ adversarial_access=false for: ${a.map((p) => p.id).join(', ')}`)

  const b = await patch('id=eq.free', { pdf_reports: false })
  console.log(`✓ pdf_reports=false for: ${b.map((p) => p.id).join(', ')}`)

  console.log('\nDone.')
}

main().catch((err) => {
  console.error('✗ fix-plan-feature-flags failed:', err.message)
  process.exit(1)
})
