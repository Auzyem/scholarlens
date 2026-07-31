# Stuck-Review Reaper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No review session can be stuck forever — within ~10 minutes of a pipeline dying, the session lands in `failed` with an explanatory message, the user's monthly quota is released, and they can retry with one click without duplicating any data.

**Architecture:** Four `timestamptz` clocks on `review_sessions`, maintained by a Postgres trigger so no application code can forget to touch them. A pure decider (`lib/review/stuck.ts`) turns a row plus a clock into a list of stuck lifecycles. A secret-guarded cron route sweeps every 5 minutes and flips each stuck lifecycle to `failed` with a **conditional** update, so a pipeline that finishes mid-sweep always wins the race. Quota release is a single clause in `checkReviewLimit`. Retry paths delete their own child rows first, fixing a pre-existing duplication bug the reaper would otherwise make routine.

**Tech Stack:** Next.js 14 App Router (route handlers), Supabase (Postgres + service-role admin client), Vercel Cron, Vitest, TypeScript, Tailwind + shadcn.

---

## Design reference

Full design: `docs/superpowers/specs/2026-07-31-stuck-review-reaper-design.md`. **Read it before starting** — this plan implements it.

## House rules (from project memory — apply throughout)

- **Build gate:** `npm test` is lenient; commits gate on **`npm run build`**. Every commit step below runs the build first.
- **`server-only`:** `lib/supabase/admin.ts` imports `server-only`, which throws if loaded under Vitest. Any test touching a module that imports it **MUST** `vi.mock('@/lib/supabase/admin', …)` so the real module never loads.
- **Pure logic lives in `lib/`, tested without Supabase** — follow `lib/plan/period.ts` and `lib/plan/gates.ts`'s `isFeatureAllowed`.
- **Design tokens:** UI uses Tailwind `pr-*` utility classes + shadcn, not inline `var(--pr-*)`.
- **Pre-existing `tsc` noise:** `npx tsc --noEmit` reports 3 errors in test files on `main` (`pdfReport.test.tsx`, `planGates.test.ts`, `userStats.test.ts`). Those are expected. Do not "fix" them; just don't add a 4th.

## Dependency on PR #35

This plan is written against a `main` that includes **PR #35** ("Close three gaps: export paywall, dead auth guard, quota window"). Branch from `main` *after* it merges. Two concrete couplings if you do not:

1. **Migration numbering.** This plan writes `018_review_session_clocks.sql`; `017_subscription_period_start.sql` comes from #35. Run `ls supabase/migrations/` first — if `017` is absent, renumber this one to `017` and adjust every reference below.
2. **Task 5's code block.** The `checkReviewLimit` snippet shown there includes #35's `windowStart` line. Without #35 that function still computes `startOfMonth` inline, so add `.neq('status', 'failed')` to *that* query instead — the one clause is all Task 5 actually changes. The Task 5 test also seeds `current_period_start` in the subscriptions mock, which only exists after #35; drop that key if it is not merged.

Start a branch for this work:

```bash
git checkout main && git pull
git checkout -b feat/stuck-review-reaper
```

## File Structure

| File | Responsibility |
|------|----------------|
| `supabase/migrations/018_review_session_clocks.sql` | **New.** Four clock columns, backfill, `touch_review_session_clocks` trigger, partial sweep index. |
| `lib/review/stuck.ts` | **New.** Pure decider: which of a row's four lifecycles are past the threshold, and the message for each. No Supabase. |
| `tests/reviewStuck.test.ts` | **New.** Unit tests for the decider. |
| `app/api/cron/reap-reviews/route.ts` | **New.** Secret-guarded sweep. Selects candidates, applies conditional updates. |
| `tests/reapReviews.test.ts` | **New.** Auth tests + the race-safety contract (both guard predicates present). |
| `app/api/review/retry/route.ts` | **New.** Main-pipeline retry: atomic claim, clear child rows, re-run. |
| `lib/ai/adversarialPipeline.ts` | **Modify.** Delete prior `adversarial_critiques` before inserting. |
| `lib/ai/journalMatchPipeline.ts` | **Modify.** Delete prior `journal_matches` before inserting. |
| `lib/ai/reportingCheckPipeline.ts` | **Modify.** Delete prior `reporting_checklist_items` before inserting. |
| `lib/plan/gates.ts` | **Modify.** `checkReviewLimit` stops counting `failed` sessions. |
| `tests/planGates.test.ts` | **Modify.** Add the quota-release test. |
| `components/review/ReviewDashboard.tsx` | **Modify.** Failed branch gains a Retry button. |
| `vercel.json` | **Modify.** `crons` entry + `maxDuration` for the sweep. |
| `.env.local.example` | **Modify.** Document `CRON_SECRET`. |

---

## Task 1: Migration — clocks and trigger

**Files:**
- Create: `supabase/migrations/018_review_session_clocks.sql`

This migration has no Vitest coverage (the project does not unit-test SQL). Verification is: file present, applies cleanly to your Supabase project, build passes.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/018_review_session_clocks.sql`:

```sql
-- Stuck-review reaper: give every review lifecycle a clock.
--
-- Five routes launch their pipeline detached via waitUntil. Each catches its own
-- errors and writes status='failed', so *handled* failures are covered. What is
-- not covered is process death — a 300s timeout, an OOM, a deploy mid-flight —
-- where the catch block never runs and the session is left in a running state
-- forever. Nothing re-examines it, the dashboard polls indefinitely, and the
-- user's monthly review allowance stays consumed by work that produced nothing.
--
-- Reaping needs to know HOW LONG a lifecycle has been in its current state, and
-- nothing recorded that. created_at is not a substitute: it is wrong for a
-- session resumed after 'awaiting_confirmation', and wrong for all three
-- sub-pipelines, which start on demand long after the session was created.
--
-- Four columns rather than one because the three sub-pipeline statuses advance
-- INDEPENDENTLY and can be 'running' concurrently — a single "stage started at"
-- cannot express that state.

alter table public.review_sessions
  add column if not exists status_updated_at timestamptz default now(),
  add column if not exists adversarial_status_updated_at timestamptz default now(),
  add column if not exists journal_match_status_updated_at timestamptz default now(),
  add column if not exists reporting_check_status_updated_at timestamptz default now();

-- Backfill existing rows. A historical row is either terminal (never reaped) or
-- already far past the threshold — so a session that has been genuinely stuck
-- since before this migration gets cleaned up on the first sweep, which is what
-- we want.
update public.review_sessions
   set status_updated_at                 = coalesce(completed_at, created_at),
       adversarial_status_updated_at     = coalesce(completed_at, created_at),
       journal_match_status_updated_at   = coalesce(completed_at, created_at),
       reporting_check_status_updated_at = coalesce(completed_at, created_at)
 where status_updated_at is null;

-- The clocks are maintained HERE, not in application code. Hand-touching every
-- status write means every future call site has to remember to do it, and one
-- missed site produces a session the reaper silently ignores forever. A trigger
-- cannot be forgotten.
--
-- `is distinct from` rather than `<>` so a NULL-to-value transition also counts
-- (the sub-pipeline columns start NULL on rows created before their migrations).
create or replace function public.touch_review_session_clocks()
returns trigger as $$
begin
  if new.status is distinct from old.status then
    new.status_updated_at := now();
  end if;
  if new.adversarial_status is distinct from old.adversarial_status then
    new.adversarial_status_updated_at := now();
  end if;
  if new.journal_match_status is distinct from old.journal_match_status then
    new.journal_match_status_updated_at := now();
  end if;
  if new.reporting_check_status is distinct from old.reporting_check_status then
    new.reporting_check_status_updated_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists on_review_session_status_change on public.review_sessions;
create trigger on_review_session_status_change
  before update on public.review_sessions
  for each row execute procedure public.touch_review_session_clocks();

-- The sweep only ever looks at non-terminal main statuses or running
-- sub-pipelines. A partial index keeps it cheap as the table grows.
create index if not exists review_sessions_sweep_idx
  on public.review_sessions (status_updated_at)
  where status in ('queued','routing','reviewing','adversarial','matching','comparing');
```

- [ ] **Step 2: Apply it**

Paste the file into the Supabase SQL editor and run it. Then verify the trigger fires:

```sql
-- Should show four timestamps, all recent:
select status, status_updated_at, adversarial_status_updated_at
  from public.review_sessions limit 5;
```

Expected: the columns exist and are populated (not null).

- [ ] **Step 3: Commit**

```bash
npm run build
git add supabase/migrations/018_review_session_clocks.sql
git commit -m "Add per-lifecycle clocks to review_sessions, maintained by trigger"
```

---

## Task 2: The pure decider

**Files:**
- Create: `lib/review/stuck.ts`
- Test: `tests/reviewStuck.test.ts`

All reaping *logic* lives here so it is testable without Supabase.

- [ ] **Step 1: Write the failing tests**

Create `tests/reviewStuck.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  findStuckLifecycles,
  stuckErrorMessage,
  STUCK_THRESHOLD_MS,
  type ReviewSessionClocks,
} from '@/lib/review/stuck'

const NOW = new Date('2026-07-31T12:00:00.000Z')
/** A clock reading `mins` minutes before NOW. */
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString()

function row(overrides: Partial<ReviewSessionClocks> = {}): ReviewSessionClocks {
  return {
    id: 'sess-1',
    status: 'complete',
    status_updated_at: ago(1),
    adversarial_status: 'not_started',
    adversarial_status_updated_at: ago(1),
    journal_match_status: 'not_started',
    journal_match_status_updated_at: ago(1),
    reporting_check_status: 'not_started',
    reporting_check_status_updated_at: ago(1),
    ...overrides,
  }
}

describe('findStuckLifecycles — main pipeline', () => {
  it('reaps a session that died mid-review', () => {
    const found = findStuckLifecycles(row({ status: 'reviewing', status_updated_at: ago(30) }), NOW)
    expect(found).toEqual([{ column: 'status', clock: 'status_updated_at', from: 'reviewing' }])
  })

  it('reaps every non-terminal main status', () => {
    for (const s of ['queued', 'routing', 'reviewing', 'adversarial', 'matching', 'comparing']) {
      const found = findStuckLifecycles(row({ status: s, status_updated_at: ago(30) }), NOW)
      expect(found, `${s} should be reapable`).toHaveLength(1)
    }
  })

  it('NEVER reaps awaiting_confirmation, however old', () => {
    // The pipeline parks here deliberately when routing confidence is low and
    // waits for the user — this can legitimately sit for days. Reaping it would
    // destroy a live review that is behaving exactly as designed.
    const found = findStuckLifecycles(
      row({ status: 'awaiting_confirmation', status_updated_at: ago(60 * 24 * 30) }),
      NOW,
    )
    expect(found).toEqual([])
  })

  it('never reaps terminal statuses', () => {
    expect(findStuckLifecycles(row({ status: 'complete', status_updated_at: ago(999) }), NOW)).toEqual([])
    expect(findStuckLifecycles(row({ status: 'failed', status_updated_at: ago(999) }), NOW)).toEqual([])
  })

  it('leaves a running pipeline inside the threshold alone', () => {
    expect(findStuckLifecycles(row({ status: 'reviewing', status_updated_at: ago(4) }), NOW)).toEqual([])
  })
})

describe('findStuckLifecycles — threshold boundary', () => {
  const at = (ms: number) =>
    findStuckLifecycles(
      row({ status: 'reviewing', status_updated_at: new Date(NOW.getTime() - ms).toISOString() }),
      NOW,
    )

  it('reaps at exactly the threshold', () => {
    expect(at(STUCK_THRESHOLD_MS)).toHaveLength(1)
  })

  it('does not reap one millisecond early', () => {
    expect(at(STUCK_THRESHOLD_MS - 1)).toEqual([])
  })

  it('reaps one millisecond late', () => {
    expect(at(STUCK_THRESHOLD_MS + 1)).toHaveLength(1)
  })
})

describe('findStuckLifecycles — sub-pipelines', () => {
  it('reaps a stuck adversarial pass', () => {
    const found = findStuckLifecycles(
      row({ adversarial_status: 'running', adversarial_status_updated_at: ago(30) }),
      NOW,
    )
    expect(found).toEqual([
      { column: 'adversarial_status', clock: 'adversarial_status_updated_at', from: 'running' },
    ])
  })

  it('reaps a stuck journal match', () => {
    const found = findStuckLifecycles(
      row({ journal_match_status: 'running', journal_match_status_updated_at: ago(30) }),
      NOW,
    )
    expect(found.map(f => f.column)).toEqual(['journal_match_status'])
  })

  it('reaps a stuck reporting check', () => {
    const found = findStuckLifecycles(
      row({ reporting_check_status: 'running', reporting_check_status_updated_at: ago(30) }),
      NOW,
    )
    expect(found.map(f => f.column)).toEqual(['reporting_check_status'])
  })

  it('ignores sub-pipelines that are not running', () => {
    for (const s of ['not_started', 'complete', 'failed']) {
      const found = findStuckLifecycles(
        row({ adversarial_status: s, adversarial_status_updated_at: ago(999) }),
        NOW,
      )
      expect(found, `${s} should be ignored`).toEqual([])
    }
  })

  it('returns every stuck lifecycle when one instance kill took several down', () => {
    const found = findStuckLifecycles(
      row({
        status: 'reviewing', status_updated_at: ago(30),
        adversarial_status: 'running', adversarial_status_updated_at: ago(30),
        reporting_check_status: 'running', reporting_check_status_updated_at: ago(30),
      }),
      NOW,
    )
    expect(found.map(f => f.column).sort()).toEqual(
      ['adversarial_status', 'reporting_check_status', 'status'],
    )
  })

  it('reaps only the overdue lifecycle when others are fresh', () => {
    const found = findStuckLifecycles(
      row({
        status: 'reviewing', status_updated_at: ago(30),
        adversarial_status: 'running', adversarial_status_updated_at: ago(2),
      }),
      NOW,
    )
    expect(found.map(f => f.column)).toEqual(['status'])
  })
})

describe('findStuckLifecycles — unusable clocks', () => {
  it('leaves a row alone when its clock is missing', () => {
    // Fail safe: with no clock we cannot know how long it has been stuck, and
    // wrongly failing a live review is worse than leaving one for a human.
    expect(findStuckLifecycles(row({ status: 'reviewing', status_updated_at: null }), NOW)).toEqual([])
  })

  it('leaves a row alone when its clock is unparseable', () => {
    expect(findStuckLifecycles(row({ status: 'reviewing', status_updated_at: 'nonsense' }), NOW)).toEqual([])
  })
})

describe('stuckErrorMessage', () => {
  it('names the stage and says the quota was released', () => {
    const msg = stuckErrorMessage({ column: 'status', clock: 'status_updated_at', from: 'reviewing' })
    expect(msg).toContain('reviewing')
    expect(msg).toMatch(/does not count/i)
  })

  it('names each sub-pipeline in plain language', () => {
    expect(
      stuckErrorMessage({ column: 'adversarial_status', clock: 'adversarial_status_updated_at', from: 'running' }),
    ).toContain('adversarial critique')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reviewStuck.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/review/stuck"`.

- [ ] **Step 3: Write the implementation**

Create `lib/review/stuck.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/reviewStuck.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
npm run build
git add lib/review/stuck.ts tests/reviewStuck.test.ts
git commit -m "Add pure decider for stuck review lifecycles"
```

---

## Task 3: The sweep route

**Files:**
- Create: `app/api/cron/reap-reviews/route.ts`
- Test: `tests/reapReviews.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/reapReviews.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Mock the service-role client so the real lib/supabase/admin (which imports
 * 'server-only') never loads under Vitest — same pattern as tests/planGates.test.ts.
 *
 * The builder records every call so the tests can assert on the SHAPE of the
 * update, which is the race-safety contract: the update must re-assert both the
 * observed status and the overdue clock, or a pipeline that finishes mid-sweep
 * would be overwritten with 'failed'.
 */
const h = vi.hoisted(() => ({
  selectResult: { data: [] as unknown[], error: null as unknown },
  updateResult: { data: [{ id: 'sess-1' }] as unknown[], error: null as unknown },
  updateCalls: [] as Array<{ patch: Record<string, unknown>; eq: [string, unknown][]; lt: [string, unknown][] }>,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const call = { patch: {} as Record<string, unknown>, eq: [] as [string, unknown][], lt: [] as [string, unknown][] }
      const builder: Record<string, unknown> = {}
      builder.select = vi.fn(() => builder)
      builder.or = vi.fn(() => builder)
      builder.limit = vi.fn(async () => h.selectResult)
      builder.update = vi.fn((patch: Record<string, unknown>) => {
        call.patch = patch
        h.updateCalls.push(call)
        return builder
      })
      builder.eq = vi.fn((col: string, val: unknown) => { call.eq.push([col, val]); return builder })
      builder.lt = vi.fn((col: string, val: unknown) => { call.lt.push([col, val]); return builder })
      // Postgrest builders are thenable; awaiting one resolves the query.
      ;(builder as unknown as PromiseLike<unknown>).then = (resolve: (v: unknown) => void) =>
        resolve(builder.update as unknown as boolean ? h.updateResult : h.selectResult)
      return builder
    },
  }),
}))

import { GET } from '@/app/api/cron/reap-reviews/route'

const SECRET = 'test-cron-secret'
const req = (auth?: string) =>
  new Request('http://localhost/api/cron/reap-reviews', {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as Parameters<typeof GET>[0]

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  h.selectResult = { data: [], error: null }
  h.updateResult = { data: [{ id: 'sess-1' }], error: null }
  h.updateCalls = []
})

describe('reap-reviews auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(h.updateCalls).toHaveLength(0)
  })

  it('rejects a wrong secret', async () => {
    const res = await GET(req('Bearer wrong-secret-value'))
    expect(res.status).toBe(401)
  })

  it('fails CLOSED when CRON_SECRET is not configured', async () => {
    // An unset secret must never mean "no auth required" — that would make this
    // a public endpoint for failing other people's reviews.
    delete process.env.CRON_SECRET
    const res = await GET(req('Bearer '))
    expect(res.status).toBe(401)
  })

  it('accepts the correct secret', async () => {
    const res = await GET(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
  })
})

describe('reap-reviews sweep', () => {
  const stuckRow = {
    id: 'sess-1',
    status: 'reviewing',
    status_updated_at: '2020-01-01T00:00:00.000Z',
    adversarial_status: 'not_started',
    adversarial_status_updated_at: '2020-01-01T00:00:00.000Z',
    journal_match_status: 'not_started',
    journal_match_status_updated_at: '2020-01-01T00:00:00.000Z',
    reporting_check_status: 'not_started',
    reporting_check_status_updated_at: '2020-01-01T00:00:00.000Z',
  }

  it('reaps a stuck session and reports it', async () => {
    h.selectResult = { data: [stuckRow], error: null }
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.scanned).toBe(1)
    expect(body.reaped).toEqual([{ sessionId: 'sess-1', column: 'status', from: 'reviewing' }])
  })

  it('guards the update with BOTH the status and the clock', async () => {
    // This is the race-safety contract. Without both predicates, a pipeline that
    // completes during the sweep would be overwritten with 'failed'.
    h.selectResult = { data: [stuckRow], error: null }
    await GET(req(`Bearer ${SECRET}`))

    expect(h.updateCalls).toHaveLength(1)
    const call = h.updateCalls[0]
    expect(call.patch.status).toBe('failed')
    expect(call.patch.error_message).toBeTruthy()
    expect(call.eq).toContainEqual(['id', 'sess-1'])
    expect(call.eq).toContainEqual(['status', 'reviewing'])
    expect(call.lt.map(([c]) => c)).toContain('status_updated_at')
  })

  it('does not count a row that changed mid-sweep as reaped', async () => {
    // The conditional update matched zero rows — the pipeline won the race.
    h.selectResult = { data: [stuckRow], error: null }
    h.updateResult = { data: [], error: null }
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.reaped).toEqual([])
  })

  it('does not touch awaiting_confirmation rows', async () => {
    h.selectResult = {
      data: [{ ...stuckRow, status: 'awaiting_confirmation' }],
      error: null,
    }
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.reaped).toEqual([])
    expect(h.updateCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/reapReviews.test.ts`
Expected: FAIL — `Failed to resolve import "@/app/api/cron/reap-reviews/route"`.

- [ ] **Step 3: Write the implementation**

Create `app/api/cron/reap-reviews/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  findStuckLifecycles,
  stuckErrorMessage,
  STUCK_THRESHOLD_MS,
  type ReviewSessionClocks,
} from '@/lib/review/stuck'

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
        console.error(`[reap-reviews] failed to reap ${row.id}/${lifecycle.column}:`, updateError.message)
        continue
      }
      if (claimed && claimed.length > 0) {
        console.warn(`[reap-reviews] ${row.id}: ${lifecycle.column} '${lifecycle.from}' -> failed`)
        reaped.push({ sessionId: row.id, column: lifecycle.column, from: lifecycle.from })
      }
    }
  }

  return NextResponse.json({ scanned: rows.length, reaped })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/reapReviews.test.ts`
Expected: PASS (all tests).

The mock's one subtlety: a single builder object serves both the candidate query and the update chain. `limit()` is `async` and resolves the select directly; the update chain has no terminal method, so it resolves through the `then` shim. If a test hangs or resolves the wrong shape, that shim is where to look — give the update path its own builder instance rather than trying to make one object guess which query it is.

- [ ] **Step 5: Commit**

```bash
npm run build
git add app/api/cron/reap-reviews/route.ts tests/reapReviews.test.ts
git commit -m "Add secret-guarded sweep that fails stuck review sessions"
```

---

## Task 4: Schedule the sweep

**Files:**
- Modify: `vercel.json`
- Modify: `.env.local.example`

- [ ] **Step 1: Add the cron entry and function timeout**

Edit `vercel.json` — add `"app/api/cron/reap-reviews/route.ts"` to `functions` and a new top-level `crons` array:

```json
{
  "functions": {
    "app/api/review/start/route.ts": {
      "maxDuration": 300
    },
    "app/api/pdf/[sessionId]/route.ts": {
      "maxDuration": 60
    },
    "app/api/billing/webhook/route.ts": {
      "maxDuration": 30
    },
    "app/api/cron/reap-reviews/route.ts": {
      "maxDuration": 60
    }
  },
  "crons": [
    {
      "path": "/api/cron/reap-reviews",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

- [ ] **Step 2: Document the secret**

Append to `.env.local.example`:

```
# Shared secret for the Vercel Cron sweep that fails stuck review sessions
# (/api/cron/reap-reviews). Vercel sends it as `Authorization: Bearer <value>`.
# The route fails closed if this is unset. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRON_SECRET=
```

- [ ] **Step 3: Set the secret in Vercel**

Generate a value and add it as an environment variable named `CRON_SECRET` (all environments) in the Vercel project settings for `scholarlens`. **Sub-daily cron frequency requires a Pro plan** — the account is a Team, so this is available.

- [ ] **Step 4: Commit**

```bash
npm run build
git add vercel.json .env.local.example
git commit -m "Schedule the stuck-review sweep every 5 minutes"
```

---

## Task 5: Release the quota

**Files:**
- Modify: `lib/plan/gates.ts` (in `checkReviewLimit`)
- Test: `tests/planGates.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/planGates.test.ts`, inside the existing `describe` for `checkReviewLimit` (match the file's existing mock setup — reuse its `mockAdmin` helper and `h.admin` assignment exactly as the neighbouring tests do):

```ts
it('does not count failed sessions against the monthly limit', async () => {
  // A review that produced nothing must not consume the user's allowance —
  // whether it failed normally or was reaped after its pipeline died.
  const calls: string[] = []
  h.admin = mockAdmin({
    user_roles: { data: [] },
    subscriptions: { data: { plan_id: 'starter', current_period_start: null, plans: { max_reviews_per_month: 4 } } },
    manuscripts: { data: [{ id: 'm1' }] },
    drafts: { data: [{ id: 'd1' }] },
    review_sessions: { count: 0 },
  })
  const original = h.admin.from
  h.admin.from = vi.fn((table: string) => {
    calls.push(table)
    return original(table)
  }) as typeof original

  const { checkReviewLimit } = await import('@/lib/plan/gates')
  const result = await checkReviewLimit('user-1')

  expect(result.allowed).toBe(true)
  expect(result.used).toBe(0)
})
```

Then assert the filter is actually applied by checking the builder recorded a `neq` call. If the existing `mockAdmin` helper does not record `neq`, add `'neq'` to its list of chainable methods (the array `['select', 'eq', 'gte', 'in', 'order']`) and capture the call:

```ts
it('excludes failed sessions via a neq filter on the count query', async () => {
  const neqCalls: [string, unknown][] = []
  h.admin = mockAdmin({
    user_roles: { data: [] },
    subscriptions: { data: { plan_id: 'starter', current_period_start: null, plans: { max_reviews_per_month: 4 } } },
    manuscripts: { data: [{ id: 'm1' }] },
    drafts: { data: [{ id: 'd1' }] },
    review_sessions: { count: 1 },
  }, neqCalls)

  const { checkReviewLimit } = await import('@/lib/plan/gates')
  await checkReviewLimit('user-1')

  expect(neqCalls).toContainEqual(['status', 'failed'])
})
```

Extend `mockAdmin` to accept the optional recorder:

```ts
function mockAdmin(responses: Record<string, unknown>, neqCalls: [string, unknown][] = []) {
  return {
    from: vi.fn((table: string) => {
      const result = responses[table] ?? { data: null, count: 0 }
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'gte', 'in', 'order']) {
        builder[m] = vi.fn(() => builder)
      }
      builder.neq = vi.fn((col: string, val: unknown) => { neqCalls.push([col, val]); return builder })
      builder.single = vi.fn(async () => result)
      builder.maybeSingle = vi.fn(async () => result)
      ;(builder as unknown as PromiseLike<unknown>).then = (resolve: (v: unknown) => void) => resolve(result)
      return builder
    }),
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/planGates.test.ts`
Expected: FAIL — the `neq` assertion fails because no `neq` is issued yet.

- [ ] **Step 3: Add the filter**

In `lib/plan/gates.ts`, in `checkReviewLimit`, add `.neq('status', 'failed')` to the count query:

```ts
  // Anchored to the subscription's billing period, not the calendar month.
  const windowStart = quotaWindowStart(periodStart, new Date())

  // A failed review produced nothing, so it must not consume the user's
  // allowance — whether it failed normally or was reaped after its pipeline
  // died. The hourly abuse cap in review/start remains the backstop against
  // someone looping deliberately.
  const { count } = await admin
    .from('review_sessions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', windowStart.toISOString())
    .neq('status', 'failed')
    .in('draft_id', draftIds)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/planGates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build
git add lib/plan/gates.ts tests/planGates.test.ts
git commit -m "Stop counting failed reviews against the monthly quota"
```

---

## Task 6: Make sub-pipeline retries idempotent

**Files:**
- Modify: `lib/ai/adversarialPipeline.ts`
- Modify: `lib/ai/journalMatchPipeline.ts`
- Modify: `lib/ai/reportingCheckPipeline.ts`

This fixes a **pre-existing** bug. All three write their rows with plain `.insert(...)` and none clears prior rows, yet all three already accept a retry from `failed` (their atomic claim admits `not_started` and `failed`). A pass that dies after its insert but before its status write therefore duplicates every row on retry. The reaper makes that path routine, so it must be fixed here.

The delete goes at the **top of the pipeline function**, not in the route, so it covers every entry path.

- [ ] **Step 1: Clear prior adversarial critiques**

In `lib/ai/adversarialPipeline.ts`, immediately after the `adversarial_status: 'running'` update inside the `try`:

```ts
    await supabase
      .from('review_sessions')
      .update({ adversarial_status: 'running' })
      .eq('id', sessionId)

    // This pass can legitimately run more than once (a retry after a failure or
    // after the reaper). Rows are written with a plain insert, so clear what a
    // previous attempt wrote or the critique list silently doubles.
    await supabase.from('adversarial_critiques').delete().eq('session_id', sessionId)
```

- [ ] **Step 2: Clear prior journal matches**

In `lib/ai/journalMatchPipeline.ts`, immediately after its `journal_match_status: 'running'` update inside the `try`:

```ts
    // Retries re-run this pass; rows are inserted, not upserted, so clear what a
    // previous attempt wrote or the match list silently doubles.
    await supabase.from('journal_matches').delete().eq('session_id', sessionId)
```

- [ ] **Step 3: Clear prior checklist items**

In `lib/ai/reportingCheckPipeline.ts`, immediately after its `reporting_check_status: 'running'` update inside the `try`:

```ts
    // Retries re-run this pass; rows are inserted, not upserted, so clear what a
    // previous attempt wrote or the checklist silently doubles.
    await supabase.from('reporting_checklist_items').delete().eq('session_id', sessionId)
```

- [ ] **Step 4: Verify the full suite still passes**

Run: `npm test`
Expected: PASS. (No new unit tests here — these deletes are verified in the manual pass in Task 9. The project does not have a Supabase integration harness, and mocking a delete would assert only that the line exists.)

- [ ] **Step 5: Commit**

```bash
npm run build
git add lib/ai/adversarialPipeline.ts lib/ai/journalMatchPipeline.ts lib/ai/reportingCheckPipeline.ts
git commit -m "Clear prior rows before re-running a sub-pipeline"
```

---

## Task 7: Main-pipeline retry route

**Files:**
- Create: `app/api/review/retry/route.ts`

The three sub-pipelines need no new route — reaping alone restores their retryability. Only the main pipeline lacks a retry entrypoint.

- [ ] **Step 1: Write the route**

Create `app/api/review/retry/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runReviewPipeline } from '@/lib/ai/pipeline'
import { checkReviewLimit } from '@/lib/plan/gates'

export const maxDuration = 300

/**
 * Re-run the main review pipeline for a session that failed — whether it failed
 * on its own or was reaped after its process died.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId } = await request.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  // RLS: this only returns the row if the session belongs to the caller. Doing
  // it through the cookie client is what enforces ownership before the
  // service-role work below.
  const { data: session, error } = await supabase
    .from('review_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .single()

  if (error || !session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.status !== 'failed') {
    return NextResponse.json({ error: 'Only a failed review can be retried' }, { status: 409 })
  }

  // Failed sessions no longer count toward the quota, so a retry genuinely
  // needs an available slot.
  const planLimit = await checkReviewLimit(user.id)
  if (!planLimit.allowed) {
    const planName = planLimit.plan[0].toUpperCase() + planLimit.plan.slice(1)
    return NextResponse.json(
      {
        error: `Monthly review limit reached (${planLimit.used}/${planLimit.limit} on the ${planName} plan)`,
        upgradeUrl: '/billing',
      },
      { status: 403 }
    )
  }

  // Atomically claim the retry: 'failed' -> 'queued' in one conditional update.
  // Concurrent requests (double-click, multi-tab) race here and exactly one
  // wins; the loser matches zero rows and gets a 409 instead of starting a
  // second pipeline against the same session.
  const { data: claimed, error: claimError } = await supabase
    .from('review_sessions')
    .update({
      status: 'queued',
      error_message: null,
      overall_score: null,
      verdict: null,
      strength_summary: null,
      weakness_summary: null,
      score_delta: null,
      completed_at: null,
    })
    .eq('id', sessionId)
    .eq('status', 'failed')
    .select('id')

  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 })
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: 'Review is already being retried' }, { status: 409 })
  }

  // Clear what the previous attempt wrote. scores/annotations are inserted, not
  // upserted, so a session that died after the scores insert would otherwise
  // come back with 16 score rows instead of 8. Service-role because the pipeline
  // itself runs detached without a user cookie.
  const admin = createAdminClient()
  await admin.from('scores').delete().eq('session_id', sessionId)
  await admin.from('annotations').delete().eq('session_id', sessionId)

  const pipeline = runReviewPipeline(sessionId)
  pipeline.catch((e) => console.error('[review retry pipeline] failed:', e))
  try {
    waitUntil(pipeline)
  } catch {
    // Non-Vercel runtime: the floating promise above continues on its own.
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Verify it compiles and the suite passes**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/api/review/retry/route.ts
git commit -m "Add retry endpoint for a failed main review pipeline"
```

---

## Task 8: Retry button

**Files:**
- Modify: `components/review/ReviewDashboard.tsx`

The failed branch is currently a bare sentence (`ReviewDashboard.tsx:124`). Polling already stops on a terminal status, so nothing about the loop changes.

- [ ] **Step 1: Replace the failed branch**

Find:

```tsx
  if (session.status === 'failed') {
    return <p className="text-destructive">Review failed: {session.error_message}</p>
  }
```

Replace with:

```tsx
  if (session.status === 'failed') {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-destructive">
          {session.error_message ?? 'The review failed.'}
        </p>
        {retryError && <p className="text-sm text-destructive">{retryError}</p>}
        <Button
          size="sm"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true)
            setRetryError(null)
            try {
              const res = await fetch('/api/review/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              })
              if (!res.ok) {
                const body = await res.json().catch(() => null)
                throw new Error(body?.error ?? `Retry failed (${res.status})`)
              }
              applySession({ ...session, status: 'queued', error_message: undefined })
              poll()
            } catch (e) {
              setRetryError(e instanceof Error ? e.message : 'Retry failed')
            } finally {
              setRetrying(false)
            }
          }}
        >
          {retrying ? 'Restarting…' : 'Retry review'}
        </Button>
      </div>
    )
  }
```

- [ ] **Step 2: Add the state and the import**

Add near the component's other `useState` declarations (alongside `timerRef`):

```tsx
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
```

Ensure `Button` is imported at the top of the file:

```tsx
import { Button } from '@/components/ui/button'
```

(If `useState` is not already imported from `react` in this file, add it to the existing import — the file already imports `useCallback`, `useEffect`, `useRef`, `useState`.)

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add components/review/ReviewDashboard.tsx
git commit -m "Explain a failed review and offer a one-click retry"
```

---

## Task 9: End-to-end verification

**Files:** none (manual)

The SQL trigger and the child-row deletes are not unit-tested — this is where they get verified. Do all five against your Supabase project.

- [ ] **Step 1: Confirm the trigger maintains the clocks**

```sql
-- Pick any session, flip its status, and confirm the clock moved.
update public.review_sessions set status = 'reviewing'
 where id = '<some-session-id>';
select status, status_updated_at from public.review_sessions where id = '<some-session-id>';
```

Expected: `status_updated_at` is now (not the original value).

- [ ] **Step 2: Reap a stuck session**

Age the clock past the threshold and run the sweep by hand:

```sql
update public.review_sessions
   set status = 'reviewing', status_updated_at = now() - interval '20 minutes'
 where id = '<some-session-id>';
```

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reap-reviews
```

Expected: `{"scanned":1,"reaped":[{"sessionId":"…","column":"status","from":"reviewing"}]}`, and the review page shows the explanation plus a Retry button instead of spinning.

- [ ] **Step 3: Confirm awaiting_confirmation survives**

```sql
update public.review_sessions
   set status = 'awaiting_confirmation', status_updated_at = now() - interval '5 days'
 where id = '<another-session-id>';
```

Run the sweep again. Expected: that session is **not** in `reaped` and its status is unchanged. This is the most important regression in the feature.

- [ ] **Step 4: Confirm the quota was released**

Load `/dashboard` and check the usage card. Expected: the reviews-used count is one lower than before the reap.

- [ ] **Step 5: Confirm retry does not duplicate**

Click **Retry review** on the reaped session and let it finish, then:

```sql
select count(*) from public.scores where session_id = '<some-session-id>';
```

Expected: **8**, not 16. Repeat for a sub-pipeline: run the adversarial pass, note the critique count, re-run it from `failed`, and confirm the count is stable rather than doubled.

- [ ] **Step 6: Final gate and push**

```bash
npm run build && npm test && npx tsc --noEmit
```

Expected: build clean, all tests pass, and `tsc` reports **only the 3 pre-existing test-file errors** — no new ones.

```bash
git push -u origin feat/stuck-review-reaper
gh pr create --base main --title "Reap stuck review sessions" --body "$(cat <<'EOF'
## Why

Five routes launch their pipeline detached via `waitUntil`. Each catches its own errors and writes `status='failed'`, so handled failures were already covered. Process death was not — a 300s timeout, an OOM, or a deploy mid-flight leaves the session in a running state permanently: the dashboard polls forever, the user's monthly allowance stays consumed by work that produced nothing, and the main pipeline had no retry entrypoint at all.

## What changed

- **Four clocks on `review_sessions`**, maintained by a Postgres trigger rather than by application code, so no future status write can forget to touch them. Four rather than one because the three sub-pipeline statuses advance independently and can run concurrently.
- **A pure decider** (`lib/review/stuck.ts`) — row + now → which lifecycles are past the 10-minute threshold (2x `maxDuration`).
- **A secret-guarded sweep** (`GET /api/cron/reap-reviews`, every 5 minutes) that flips each stuck lifecycle to `failed`. The update is conditional on both the observed status and the overdue clock, so a pipeline that finishes mid-sweep wins the race and is never overwritten.
- **`awaiting_confirmation` is explicitly excluded** — it is a deliberate pause waiting on the user and can legitimately sit for days.
- **Failed reviews no longer count against `max_reviews_per_month`**, which also corrects an existing unfairness.
- **Retry**: a new route for the main pipeline; the sub-pipelines already accepted retry from `failed`.
- **Fixes a pre-existing duplication bug** — none of the pipelines cleared prior rows before inserting, so any retry after a partial write doubled its output. Latent before; the reaper would have made it routine.

## Verification

See the plan's Task 9 for the manual pass (trigger fires, stuck session reaped, `awaiting_confirmation` survives a 5-day-old clock, quota returns, retry yields 8 score rows not 16).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After merge, confirm in the Vercel dashboard that the cron is registered and firing (Project → Settings → Cron Jobs), and check the first few invocations' logs for `[reap-reviews]` lines.

---

## Notes for the implementer

- **Do not** add clock-touching code to the pipelines or routes. The trigger owns those columns; a second writer is how they drift.
- The reapable status list exists **twice** — `REAPABLE_MAIN_STATUSES` in `lib/review/stuck.ts` and the `where` clause of `review_sessions_sweep_idx` in the migration. SQL cannot import from TypeScript, so this duplication is unavoidable; if you ever add a status to the main lifecycle, update both. The index only affects the query plan, so a mismatch degrades performance rather than correctness — which is exactly why it would go unnoticed.
- **Do not** widen the reaper to `awaiting_confirmation`, however stale it looks. It is a live state waiting on a human.
- The conditional update in the sweep is load-bearing. If you find yourself simplifying it to a plain `.eq('id', …)`, you have reintroduced the race where a review that completed during the sweep gets marked failed.
- `stuckErrorMessage` is user-facing copy — it appears verbatim on the review page.
