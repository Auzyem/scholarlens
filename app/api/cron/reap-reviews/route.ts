import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  findStuckLifecycles,
  stuckErrorMessage,
  STUCK_THRESHOLD_MS,
  type ReviewSessionClocks,
} from '@/lib/review/stuck'
import { releaseReviewCredit } from '@/lib/plan/ledger'

export const maxDuration = 60

/**
 * Sweep for review sessions whose pipeline died without writing a terminal
 * status, and fail them so the user gets an answer and their quota back.
 *
 * GET rather than POST because Vercel Cron invokes the path with a GET. It
 * mutates by design; CRON_SECRET is what makes that safe.
 *
 * Idempotent — safe to run repeatedly and safe to run by hand.
 */

const SWEEP_COLUMNS =
  'id, status, status_updated_at, ' +
  'adversarial_status, adversarial_status_updated_at, ' +
  'journal_match_status, journal_match_status_updated_at, ' +
  'reporting_check_status, reporting_check_status_updated_at'

const CLOCKS = [
  'status_updated_at',
  'adversarial_status_updated_at',
  'journal_match_status_updated_at',
  'reporting_check_status_updated_at',
] as const

/** One sweep's worth of rows. Logged when hit so a truncated sweep is visible. */
const MAX_ROWS_PER_SWEEP = 500

/** Constant-time compare so the secret can't be recovered by timing the endpoint. */
function secretMatches(header: string, expected: string): boolean {
  if (header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < header.length; i++) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  // Fail closed. An unset secret must never mean "open" — this endpoint can
  // fail other people's reviews.
  if (!secret) {
    console.error('[reap-reviews] CRON_SECRET is not set; refusing to run')
    return false
  }
  return secretMatches(request.headers.get('authorization') ?? '', `Bearer ${secret}`)
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const cutoff = new Date(now.getTime() - STUCK_THRESHOLD_MS).toISOString()
  const admin = createAdminClient()

  // Any one of the four clocks being overdue makes the row a candidate; the
  // pure decider then says which of its lifecycles actually qualify.
  const { data, error } = await admin
    .from('review_sessions')
    .select(SWEEP_COLUMNS)
    .or(CLOCKS.map((c) => `${c}.lt.${cutoff}`).join(','))
    .limit(MAX_ROWS_PER_SWEEP)

  if (error) {
    console.error('[reap-reviews] candidate query failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as unknown as ReviewSessionClocks[]
  if (rows.length === MAX_ROWS_PER_SWEEP) {
    console.warn(
      `[reap-reviews] hit the ${MAX_ROWS_PER_SWEEP}-row cap; more candidates remain ` +
      `and will be picked up by the next sweep`,
    )
  }

  const reaped: { sessionId: string; column: string; from: string }[] = []

  for (const row of rows) {
    for (const lifecycle of findStuckLifecycles(row, now)) {
      const patch: Record<string, string> = { [lifecycle.column]: 'failed' }
      // Only the main lifecycle has somewhere to put the explanation.
      if (lifecycle.column === 'status') {
        patch.error_message = stuckErrorMessage(lifecycle)
      }

      // Conditional update — the same atomic-claim pattern the reporting route
      // uses. Re-asserting the observed status AND the overdue clock means a
      // pipeline that finished during this sweep has already changed one of
      // them, so this matches zero rows and the good outcome wins.
      const { data: claimed, error: updateError } = await admin
        .from('review_sessions')
        .update(patch)
        .eq('id', row.id)
        .eq(lifecycle.column, lifecycle.from)
        .lt(lifecycle.clock, cutoff)
        .select('id')

      if (updateError) {
        console.error(
          `[reap-reviews] failed to reap ${row.id}/${lifecycle.column}:`,
          updateError.message,
        )
        continue
      }
      if (claimed && claimed.length > 0) {
        // Only the main lifecycle ever held a review credit; the three
        // sub-pipelines run on an already-charged session.
        if (lifecycle.column === 'status') {
          await releaseReviewCredit(row.id)
        }
        console.warn(`[reap-reviews] ${row.id}: ${lifecycle.column} '${lifecycle.from}' -> failed`)
        reaped.push({ sessionId: row.id, column: lifecycle.column, from: lifecycle.from })
      }
    }
  }

  return NextResponse.json({ scanned: rows.length, reaped })
}
