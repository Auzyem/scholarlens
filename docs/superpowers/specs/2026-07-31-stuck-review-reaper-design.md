# Stuck-review reaper — Design

**Date:** 2026-07-31
**Status:** Approved, ready for implementation plan

## Problem

Five routes launch their AI pipeline **detached** from the request via
`waitUntil` (`review/start`, `review/confirm`, `review/adversarial/start`,
`review/journals/start`, `review/reporting/start`), each with
`maxDuration = 300`. Every pipeline wraps its work in `try/catch` and writes
`status = 'failed'` on error, so *handled* failures are already covered.

What is not covered is **process death** — the case where the catch block never
runs at all:

- the function exceeds 300s and Vercel kills it,
- it runs out of memory,
- a deploy replaces the instance mid-flight,
- the runtime crashes.

When that happens the session is left in a running state (`queued`, `routing`,
`reviewing`, or a sub-pipeline's `running`) **permanently**. Nothing in the
system ever re-examines it. Concretely:

1. `ReviewDashboard` polls every 3 seconds forever — the loop only stops on a
   terminal status, so the tab spins indefinitely.
2. The user's monthly review allowance has already been consumed by work that
   produced nothing.
3. There is no retry: the main pipeline has no retry entrypoint at all.
4. Nobody is alerted. The failure is invisible unless someone reads Vercel logs.

Billing has a remedy for exactly this class of drift
(`POST /api/admin/billing/reconcile`, which re-reads Stripe and makes the
database agree). Reviews have no equivalent.

### There are four independent lifecycles, not one

`review_sessions` carries four status columns that advance independently, and
the three sub-pipeline columns can be `running` **concurrently** (the poll loop
checks all three separately):

| Column | States |
|---|---|
| `status` | `queued`, `routing`, `awaiting_confirmation`, `reviewing`, `adversarial`, `matching`, `comparing`, `complete`, `failed` |
| `adversarial_status` | `not_started`, `running`, `complete`, `failed` |
| `journal_match_status` | `not_started`, `running`, `complete`, `failed` |
| `reporting_check_status` | `not_started`, `running`, `complete`, `failed` |

Because they run concurrently, a single "current stage started at" column cannot
express the state — each lifecycle needs its own clock.

### `awaiting_confirmation` is not stuck

When the discipline router returns confidence below `CONFIDENCE_THRESHOLD`, the
pipeline **deliberately** parks the session at `awaiting_confirmation` and waits
for the user to confirm the field (`lib/ai/pipeline.ts`). This can legitimately
sit for days. A naive "old and not complete" sweep would destroy these. It must
be excluded explicitly.

### Retrying duplicates rows today (pre-existing latent bug)

`scores`, `annotations`, `adversarial_critiques`, `journal_matches` and
`reporting_checklist_items` are all written with plain `.insert(...)` — none of
the pipelines clear prior rows first. The three sub-pipelines *already* accept a
retry from `failed` (their atomic claim admits `not_started` and `failed`), so a
sub-pipeline that dies after its insert but before its status write will, on
retry, duplicate every row it already wrote.

This is latent today because reaching `failed` after a successful insert is
rare. **The reaper makes it routine**, because it creates `failed` rows
precisely for pipelines that died at an arbitrary point. Fixing it is therefore
in scope here, not a separate concern.

## Goal

No review session can be stuck forever. Within ~10 minutes of a pipeline dying,
the session lands in `failed` with an explanatory message, the user's quota is
released, and the user can retry with one click — without any retry ever
duplicating data or spending Claude tokens unasked.

## Decisions locked during brainstorming

1. **Detection is a scheduled sweep, not lazy-on-poll.** A Vercel cron every 5
   minutes. Lazy detection (marking a session failed when a client happens to
   poll it) was rejected because it only ever repairs sessions someone is
   actively watching — close the tab and the session stays stuck forever with
   the quota still consumed, and the sweep is also what makes abandoned sessions
   recoverable. The Vercel account is a **Team** (Pro), so sub-daily cron
   frequency is available.
2. **Reap to `failed`, release the quota, offer a manual retry. No auto-retry.**
   The most likely cause of a stuck review is a manuscript large enough to
   exceed 300s, which fails identically on retry — auto-retry would double the
   token spend on exactly the cases that cannot succeed. Retrying stays a human
   decision.
3. **Failed sessions stop counting against `max_reviews_per_month`.** This is
   the quota release, and it corrects an existing unfairness: today a review
   that dies for *any* reason still burns the user's monthly allowance.
4. **Four clocks, one per lifecycle** (rejected: reusing `created_at`, which is
   wrong for the resumed-after-confirmation path and for all three sub-pipelines
   that start long after session creation; and a separate `pipeline_runs` table,
   which duplicates state the status columns already hold and can drift from it).
5. **The clocks are maintained by a database trigger, not by application code.**
   Hand-touching every status write means every future call site must remember
   to do it, and a missed one produces a session the reaper silently ignores
   forever. A trigger cannot be forgotten.
6. **Threshold: 10 minutes**, i.e. 2× `maxDuration`. Long enough that a slow but
   live pipeline is never reaped; short enough that a user is not left staring
   at a spinner.

## Architecture

### 1. Migration — four clocks and a trigger

`supabase/migrations/018_review_session_clocks.sql`

> Numbering note: `017_subscription_period_start.sql` is introduced by PR #35.
> If that PR has not merged when this is implemented, renumber accordingly.

Adds four `timestamptz` columns, each defaulting to `now()` so a freshly created
row always has a live clock:

- `status_updated_at`
- `adversarial_status_updated_at`
- `journal_match_status_updated_at`
- `reporting_check_status_updated_at`

Backfill for existing rows: set each to `coalesce(completed_at, created_at)`. A
historical row is then either terminal (never reaped) or already far past the
threshold, so any genuinely-stuck session predating this migration gets cleaned
up on the first sweep — which is the desired outcome.

A `BEFORE UPDATE` trigger bumps each clock when, and only when, its own status
column changes:

```sql
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
```

`is distinct from` (not `<>`) so a NULL-to-value transition also counts.

**No application code writes these columns.** That is the point of the trigger.

Index for the sweep: a partial index on `status_updated_at` restricted to the
non-terminal statuses keeps the query cheap as the table grows.

### 2. Pure decider — `lib/review/stuck.ts`

All reaping *logic* lives in a pure function so it can be tested without
Supabase, matching how `lib/plan/period.ts` and the gate predicates are built.

```ts
export type StuckLifecycle =
  | { column: 'status'; clock: 'status_updated_at'; from: string }
  | { column: 'adversarial_status'; clock: 'adversarial_status_updated_at'; from: 'running' }
  | { column: 'journal_match_status'; clock: 'journal_match_status_updated_at'; from: 'running' }
  | { column: 'reporting_check_status'; clock: 'reporting_check_status_updated_at'; from: 'running' }

/** Statuses the main pipeline can die in. Excludes the terminal states AND
 *  'awaiting_confirmation', which is a deliberate, open-ended pause. */
export const REAPABLE_MAIN_STATUSES = [
  'queued', 'routing', 'reviewing', 'adversarial', 'matching', 'comparing',
] as const

export const STUCK_THRESHOLD_MS = 10 * 60 * 1000

/** Which of this row's four lifecycles are past the threshold? */
export function findStuckLifecycles(
  row: ReviewSessionClocks,
  now: Date,
  thresholdMs?: number,
): StuckLifecycle[]

/** Explanatory text for a reaped lifecycle — states the cause and that the
 *  quota was released. Only the main `status` lifecycle has an error_message
 *  column to store it in; for the sub-pipelines it is used for the log line. */
export function stuckErrorMessage(lifecycle: StuckLifecycle): string
```

A row can return more than one lifecycle (e.g. the adversarial and reporting
passes both died in the same instance kill), and each is reaped independently.

### 3. Cron route — `GET /api/cron/reap-reviews`

`GET`, not `POST`, because Vercel Cron invokes the path with a GET request. It
mutates by design; the `CRON_SECRET` check below is what makes that safe.

Shaped like `/api/admin/billing/reconcile`: idempotent, safe to run repeatedly,
returns a summary.

**Auth:** an `Authorization: Bearer ${CRON_SECRET}` header, compared against the
`CRON_SECRET` env var. Vercel Cron sends this automatically. The comparison is
constant-time. A missing or unset secret is a **401 fail-closed**, never an
open endpoint — the route must not become a public way to fail other people's
reviews.

**Query:** select candidate rows where **any** of the four clocks is older than
the cutoff (a single query with an `or` across them), then hand each row to
`findStuckLifecycles` to decide which of its lifecycles actually qualify.

**Write — conditional, one update per stuck lifecycle:**

```
update review_sessions
   set <column> = 'failed', error_message = <message>
 where id = <id>
   and <column> = <the observed stuck value>      -- still stuck?
   and <clock> < <cutoff>                          -- still overdue?
```

This is the same atomic-claim pattern the reporting route already uses, and it
is what makes the reaper safe against the obvious race: if the pipeline was
merely slow and finishes during the sweep, its own write lands first, the
predicate no longer matches, zero rows update, and the good outcome wins. The
reaper never overwrites a `complete`.

Only the main `status` lifecycle sets `error_message` (the sub-pipelines have no
per-pipeline error column; their `failed` state plus the UI's existing copy is
enough).

**Response:** `{ scanned, reaped: [{ sessionId, column, from }] }`, and one
`console.warn` per reaped lifecycle so the sweep leaves a trace in the logs.

### 4. Schedule — `vercel.json`

```json
"crons": [{ "path": "/api/cron/reap-reviews", "schedule": "*/5 * * * *" }]
```

Plus `CRON_SECRET` in the Vercel environment (and `.env.local.example`, so a
local checkout documents it).

### 5. Quota release — `lib/plan/gates.ts`

`checkReviewLimit` adds `.neq('status', 'failed')` to its count query, so a
review that produced nothing does not consume the user's allowance — regardless
of whether it was reaped or failed normally.

Note the deliberate trade: a user could burn Claude tokens on repeated failures
without consuming quota. That is the correct side to err on (a failure is our
fault, not theirs), the failures still cost them time, and the existing hourly
abuse rate-limit in `review/start` remains the backstop against a loop.

### 6. Retry

**Sub-pipelines need no new route.** Their atomic claim already admits `failed`,
so reaping alone restores retryability; the UI already exposes their trigger
buttons.

**The main pipeline needs one:** `POST /api/review/retry`, cookie-auth,
ownership enforced by RLS. It atomically claims the session
(`.eq('status', 'failed')` → `'queued'`, so a double-click cannot start two
pipelines), clears child rows, and re-runs `runReviewPipeline` under `waitUntil`.
It also re-checks `checkReviewLimit` — with failed sessions no longer counted,
a retry legitimately needs an available slot.

**Child-row clearing (the duplication fix).** Every retry path deletes what its
own pass wrote, before re-running:

| Retried pass | Rows deleted first |
|---|---|
| main review | `scores`, `annotations` for the session; reset `score_delta`, `overall_score`, `verdict`, `strength_summary`, `weakness_summary`, `completed_at` |
| adversarial | `adversarial_critiques` for the session |
| journal match | `journal_matches` for the session |
| reporting check | `reporting_checklist_items` for the session |

For the three sub-pipelines this is a delete at the **top of the pipeline
function** (in `lib/ai/*Pipeline.ts`), not in the route — that way it covers
every entry path and fixes the pre-existing bug rather than only the reaper's
new one.

### 7. UI

`ReviewDashboard` already renders a terminal `failed` state
(`components/review/ReviewDashboard.tsx:124`) and already stops polling on it,
so no polling changes are needed. That branch gains:

- the `error_message` text, so a reaped session explains itself, and
- a **Retry review** button calling `POST /api/review/retry`, which on success
  resumes the existing poll loop.

## Testing

**Unit — `tests/reviewStuck.test.ts`** (pure decider, no Supabase):

- each of the four lifecycles detected independently;
- multiple lifecycles stuck on one row returned together;
- `awaiting_confirmation` never reaped, however old — the regression that
  matters most;
- `complete` and `failed` never reaped;
- boundary: at exactly the threshold, and one millisecond either side;
- a running lifecycle inside the threshold left alone;
- `not_started` sub-pipelines ignored.

**Unit — cron route**, with a mocked admin client:

- missing/incorrect/absent-env `CRON_SECRET` → 401, and the query never runs;
- the update is issued with **both** guard predicates present (this is the
  race-safety contract — assert on the builder calls);
- a row whose status changed mid-sweep matches zero rows and is not counted
  as reaped.

**Unit — `tests/planGates.test.ts`** (extend): failed sessions do not count
toward `max_reviews_per_month`.

**Not unit-tested:** the SQL trigger (the project does not test SQL) and the
child-row deletes. Both are covered by the manual pass below.

**Manual:**

1. Start a review, kill the pipeline mid-flight (or set the clock back in SQL),
   run the cron route by hand, confirm the session flips to `failed` with a
   message and the dashboard stops spinning.
2. Confirm the quota display goes back up by one.
3. Retry it; confirm exactly 8 score rows afterwards, not 16.
4. Park a session at `awaiting_confirmation`, age its clock well past the
   threshold, sweep, and confirm it is untouched.

`npm run build` and `npm test` must pass (house rule).

## Out of scope (YAGNI)

- **Auto-retry** — decided against above.
- **An admin view of reaped sessions.** The existing admin user views plus
  `error_message` cover diagnosis; a dedicated screen is unjustified until the
  rate is known.
- **Alerting on the reap rate.** This wants real error monitoring (the project
  has none — see the audit), and bolting a one-off alert onto the cron route
  would be the wrong shape for it.
- **Refunding the *manuscript* limit.** Manuscripts are not consumed by a failed
  review; only the monthly review count is.
- **Making the pipelines resumable** (checkpointing so a retry continues from
  the last completed stage instead of restarting). A much larger change, and
  restarting is acceptable at current manuscript sizes.
