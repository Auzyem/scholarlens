#!/usr/bin/env node
/**
 * One-time backfill of usage_events from surviving review sessions.
 *
 * Usage used to be *derived* (walk manuscripts -> drafts -> review_sessions and
 * count). The new usage_events ledger records it instead. Without this backfill,
 * every existing user starts at zero usage the moment the ledger goes live and
 * gets a full fresh allowance.
 *
 * Sessions whose manuscript has already been deleted are unreachable through the
 * join (manuscripts/drafts/review_sessions all cascade on delete) and go
 * uncounted. This is a deliberate one-time amnesty, not a bug — there is no way
 * to recover who owned a deleted manuscript's usage.
 *
 * Idempotent: existing usage_events rows are read first and anything already
 * recorded (by review_session_id for reviews, by manuscript_id for slots) is
 * skipped, and inserts also carry Prefer: resolution=ignore-duplicates. Re-running
 * inserts nothing new.
 *
 * Dry run by default — reports counts only. Pass --apply to write.
 *
 * Reads .env.local explicitly. OS-level environment variables shadow the file on
 * this machine and have previously pointed scripts at the wrong Supabase project
 * (see scripts/diag-auth-identities.mjs).
 *
 * Run:  node scripts/backfill-usage-ledger.mjs          (dry run — reports only)
 *       node scripts/backfill-usage-ledger.mjs --apply   (writes usage_events)
 */
import fs from 'node:fs'

const APPLY = process.argv.includes('--apply')

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)

const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local')
  process.exit(1)
}

console.log(`project: ${url}`)
console.log(APPLY ? 'mode: APPLY — usage_events will be written' : 'mode: DRY RUN — nothing will be written (pass --apply to write)')

async function rest(path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

async function main() {
  // Every completed session, with its owning manuscript reached through the
  // to-one embeds review_sessions -> drafts -> manuscripts (matches the nested
  // select shape used elsewhere, e.g. lib/ai/pipeline.ts's
  // `.select('*, drafts(*, manuscripts(*))')`). Sessions whose manuscript was
  // already deleted simply have drafts.manuscripts come back null — that's the
  // amnesty case, not an error.
  const sessions = await rest(
    'review_sessions?status=eq.complete&select=id,created_at,completed_at,drafts(manuscript_id,manuscripts(id,user_id))'
  )
  console.log(`completed sessions found: ${sessions.length}`)

  const existing = await rest('usage_events?select=review_session_id,manuscript_id,kind')
  const seenSessions = new Set(existing.filter((e) => e.review_session_id).map((e) => e.review_session_id))
  const seenSlots = new Set(
    existing.filter((e) => e.kind === 'manuscript_slot' && e.manuscript_id).map((e) => e.manuscript_id)
  )

  const reviewRows = []
  const slotRows = []
  let amnestied = 0

  for (const s of sessions) {
    const manuscript = s.drafts?.manuscripts
    if (!manuscript) {
      amnestied++
      continue // manuscript already deleted — amnesty, see header comment
    }
    const stamp = s.completed_at ?? s.created_at

    if (!seenSessions.has(s.id)) {
      reviewRows.push({
        user_id: manuscript.user_id,
        kind: 'review',
        state: 'consumed',
        manuscript_id: manuscript.id,
        review_session_id: s.id,
        window_start: stamp,
        created_at: s.created_at,
        consumed_at: stamp,
      })
      seenSessions.add(s.id)
    }

    if (!seenSlots.has(manuscript.id)) {
      slotRows.push({
        user_id: manuscript.user_id,
        kind: 'manuscript_slot',
        state: 'consumed',
        manuscript_id: manuscript.id,
        window_start: stamp,
        consumed_at: stamp,
      })
      seenSlots.add(manuscript.id)
    }
  }

  console.log(`sessions with a deleted manuscript (amnestied, uncounted): ${amnestied}`)
  console.log(`review credits to insert: ${reviewRows.length}`)
  console.log(`manuscript slots to insert: ${slotRows.length}`)

  if (!APPLY) {
    console.log('\ndry run complete — nothing written')
    return
  }

  for (const batch of [reviewRows, slotRows]) {
    for (let i = 0; i < batch.length; i += 200) {
      await rest('usage_events', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify(batch.slice(i, i + 200)),
      })
    }
  }

  console.log('\n✓ backfill complete')
}

main().catch((err) => {
  console.error('✗ backfill-usage-ledger failed:', err.message)
  process.exit(1)
})
