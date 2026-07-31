/**
 * Decides which of a review session's four lifecycles have died.
 *
 * Pure on purpose: no Supabase, no clock of its own, `now` injected. The sweep
 * route is then a thin shell around this, and every rule below — especially the
 * awaiting_confirmation exclusion — is testable directly.
 */

/** The columns the sweep reads. Mirrors the select in the cron route. */
export interface ReviewSessionClocks {
  id: string
  status: string
  status_updated_at: string | null
  adversarial_status: string | null
  adversarial_status_updated_at: string | null
  journal_match_status: string | null
  journal_match_status_updated_at: string | null
  reporting_check_status: string | null
  reporting_check_status_updated_at: string | null
}

export type StuckColumn =
  | 'status'
  | 'adversarial_status'
  | 'journal_match_status'
  | 'reporting_check_status'

export type StuckClock =
  | 'status_updated_at'
  | 'adversarial_status_updated_at'
  | 'journal_match_status_updated_at'
  | 'reporting_check_status_updated_at'

export interface StuckLifecycle {
  column: StuckColumn
  clock: StuckClock
  /** The value observed as stuck. The sweep's conditional update re-asserts it. */
  from: string
}

/**
 * Main-pipeline statuses that indicate work in flight.
 *
 * Excludes 'complete' and 'failed' (terminal) and — critically —
 * 'awaiting_confirmation', which is a DELIBERATE pause: when the discipline
 * router's confidence is below threshold the pipeline parks there and waits for
 * the user to confirm the field. That can sit for days and must never be reaped.
 *
 * Duplicated in the partial index in migration 018 (SQL cannot import from
 * TypeScript). Adding a status here means updating that index too.
 */
export const REAPABLE_MAIN_STATUSES = [
  'queued',
  'routing',
  'reviewing',
  'adversarial',
  'matching',
  'comparing',
] as const

/**
 * 10 minutes — 2x the routes' `maxDuration` of 300s. Past this, a pipeline is
 * not slow, it is gone. The margin keeps a legitimately long run from being
 * killed while it still might finish.
 */
export const STUCK_THRESHOLD_MS = 10 * 60 * 1000

const SUB_LIFECYCLES: ReadonlyArray<{ column: StuckColumn; clock: StuckClock }> = [
  { column: 'adversarial_status', clock: 'adversarial_status_updated_at' },
  { column: 'journal_match_status', clock: 'journal_match_status_updated_at' },
  { column: 'reporting_check_status', clock: 'reporting_check_status_updated_at' },
]

function isOverdue(clock: string | null | undefined, now: Date, thresholdMs: number): boolean {
  // No clock, or an unreadable one, means we cannot say how long this has been
  // running. Fail safe: leave it for a human. Wrongly failing a live review is
  // worse than missing a dead one, which the next sweep catches anyway once the
  // trigger has written a real timestamp.
  if (!clock) return false
  const t = new Date(clock).getTime()
  if (Number.isNaN(t)) return false
  return now.getTime() - t >= thresholdMs
}

/** Every lifecycle on this row that is past the threshold. Can return several. */
export function findStuckLifecycles(
  row: ReviewSessionClocks,
  now: Date,
  thresholdMs: number = STUCK_THRESHOLD_MS,
): StuckLifecycle[] {
  const stuck: StuckLifecycle[] = []

  if (
    (REAPABLE_MAIN_STATUSES as readonly string[]).includes(row.status) &&
    isOverdue(row.status_updated_at, now, thresholdMs)
  ) {
    stuck.push({ column: 'status', clock: 'status_updated_at', from: row.status })
  }

  for (const { column, clock } of SUB_LIFECYCLES) {
    if (row[column] === 'running' && isOverdue(row[clock], now, thresholdMs)) {
      stuck.push({ column, clock, from: 'running' })
    }
  }

  return stuck
}

const STAGE_LABEL: Record<StuckColumn, string> = {
  status: 'review',
  adversarial_status: 'adversarial critique',
  journal_match_status: 'journal match',
  reporting_check_status: 'reporting checklist',
}

/**
 * Explanatory text for a reaped lifecycle. Only the main `status` lifecycle has
 * an `error_message` column to store it in; for the sub-pipelines it is the log
 * line. Says the quota was released because that is the user's first question.
 */
export function stuckErrorMessage(lifecycle: StuckLifecycle): string {
  const where = lifecycle.column === 'status' ? ` during the "${lifecycle.from}" stage` : ''
  return (
    `The ${STAGE_LABEL[lifecycle.column]} stopped unexpectedly${where} and did not finish. ` +
    `This does not count against your monthly limit — you can start it again.`
  )
}
