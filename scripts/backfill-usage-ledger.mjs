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
 * skipped. Re-running inserts nothing new.
 *
 * That guarantee rests entirely on the pre-read being COMPLETE, which is why
 * both reads page (see restAll) and assert their row count against the server's
 * own. Prefer: resolution=ignore-duplicates is not a second line of defence:
 * there is no unique constraint on review_session_id (migration 019 indexes it
 * non-uniquely), so a duplicate review row is a perfectly legal insert and
 * Postgres has no conflict to ignore. A truncated pre-read would double-charge.
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

/** Rows requested per page. PostgREST clamps this down to its own max-rows. */
const PAGE = 1000

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

  // A PostgREST insert answers 201 with an EMPTY body unless it was asked for a
  // representation, so parsing unconditionally throws "Unexpected end of JSON
  // input" *after* the rows have already committed — which is how the first
  // apply run wrote its review credits and then died before the slots. Decide
  // by the body itself rather than by guessing which statuses carry one.
  const body = await res.text()
  return body ? JSON.parse(body) : null
}

/**
 * Read every row of `path`, one Range page at a time.
 *
 * An unpaged read is silently truncated at PostgREST's max-rows — no error, no
 * flag, just a short array. That breaks this script in both directions: a
 * truncated session read under-charges users, and a truncated read of the
 * *existing* ledger breaks the idempotency guard, because `Prefer:
 * resolution=ignore-duplicates` has nothing to ignore (migration 019 indexes
 * review_session_id non-uniquely, so a duplicate insert is a legal insert).
 *
 * Pages by Range header rather than offset/limit params so it works unchanged
 * on paths that already carry a query string. The page size we ask for is only
 * an upper bound — the server may hand back fewer — so the loop advances by
 * what actually arrived and stops on an empty page, which is also what makes a
 * total that is an exact multiple of the page size terminate correctly.
 *
 * Prefer: count=exact makes the server report the true total in Content-Range;
 * anything short of it means we were still truncated, and that must be loud.
 */
async function restAll(path, label) {
  const rows = []
  let total = null
  let pages = 0

  for (;;) {
    const from = rows.length
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Range-Unit': 'items',
        Range: `${from}-${from + PAGE - 1}`,
        Prefer: 'count=exact',
      },
    })

    // Some PostgREST versions answer a past-the-end range with 416 instead of
    // an empty array. Both mean the same thing here: nothing left to read.
    if (res.status === 416) break
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)

    const reported = (res.headers.get('content-range') ?? '').split('/')[1]
    if (reported && reported !== '*') total = Number(reported)

    const batch = await res.json()
    pages++
    rows.push(...batch)

    if (batch.length === 0) break
    if (total !== null && rows.length >= total) break
  }

  console.log(
    `${label}: ${rows.length} rows read in ${pages} page(s)` +
      (total === null ? ' (server reported no count)' : ` (server count: ${total})`)
  )

  // The whole point of paging: if the accumulated total still disagrees with
  // the server's own count, we are working from a partial picture and every
  // number below is wrong. Stop rather than write from it.
  if (total !== null && rows.length !== total) {
    throw new Error(
      `${label}: read ${rows.length} rows but the server counts ${total} — refusing to continue on a partial read`
    )
  }

  return rows
}

async function main() {
  // Every completed session, with its owning manuscript reached through the
  // to-one embeds review_sessions -> drafts -> manuscripts (matches the nested
  // select shape used elsewhere, e.g. lib/ai/pipeline.ts's
  // `.select('*, drafts(*, manuscripts(*))')`). Sessions whose manuscript was
  // already deleted simply have drafts.manuscripts come back null — that's the
  // amnesty case, not an error.
  //
  // Both reads are paged, and both carry an explicit `order=id`: page N+1 is
  // requested by row offset, so without a total order the server is free to
  // return rows in a different order each page, which would drop and repeat
  // rows across the seam.
  const sessions = await restAll(
    'review_sessions?status=eq.complete&order=id&select=id,created_at,completed_at,drafts(manuscript_id,manuscripts(id,user_id))',
    'completed sessions'
  )

  const existing = await restAll(
    'usage_events?order=id&select=review_session_id,manuscript_id,kind',
    'existing usage_events'
  )
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
