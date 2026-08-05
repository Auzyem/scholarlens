# Durable usage ledger, one-time Free tier, Re-Review, and password-identity recovery — Design

**Date:** 2026-08-05
**Status:** Approved, ready for implementation plan

## Problem

Five defects, four of them sharing one root cause.

### 1. Deleting a manuscript refunds usage

Usage is **derived from live rows**, never recorded. `checkReviewLimit`
(`lib/plan/gates.ts:74`) resolves the caller's allowance by walking
`manuscripts → drafts → review_sessions` and counting sessions in the window:

```ts
const { data: manuscripts } = await admin.from('manuscripts').select('id').eq('user_id', userId)
const { data: drafts } = await admin.from('drafts').select('id').in('manuscript_id', manuscriptIds)
const { count } = await admin.from('review_sessions')
  .select('*', { count: 'exact', head: true })
  .gte('created_at', windowStart.toISOString())
  .neq('status', 'failed')
  .in('draft_id', draftIds)
```

Every link in that chain is `on delete cascade`
(`001_initial_schema.sql:29,42`). `DELETE /api/manuscripts/[id]`
(`app/api/manuscripts/[id]/route.ts:30`) removes the manuscript, which removes
its drafts, which removes their review sessions. The count drops back and the
allowance is restored. A user on any plan can run reviews indefinitely by
deleting each manuscript afterwards.

`checkManuscriptLimit` (`lib/plan/gates.ts:46`) has the same shape — it counts
non-archived `manuscripts` rows, so both deleting *and* archiving free a slot.

This is not a bug in one query. There is no record anywhere in the schema that a
review was ever consumed, so no query can be written correctly against the
current tables. **A durable ledger is required.**

### 2. Usage is charged at the wrong moment

`POST /api/review/start` inserts the session at `status: 'queued'`
(`app/api/review/start/route.ts:79`) and the count includes every non-`failed`
session. The credit is therefore spent the instant a review is started, before
any output exists. A user who uploads the wrong file or changes their mind has
already paid.

### 3. The Free plan renews forever

`plans.max_reviews_per_month` is `2` for `free` (`006_saas_scaffold.sql:19`) and
`quotaWindowStart` (`lib/plan/period.ts:50`) falls back to the calendar month
when there is no billing anchor — which is always true for free rows. Free users
receive 2 fresh reviews every month, permanently, with no reason to upgrade.

### 4. No Re-Review entry point

The dashboard has a single "New review" button
(`app/(dashboard)/dashboard/page.tsx:10`). The revision flow exists and the
pipeline already compares a new draft against the previous one and computes a
score delta (`lib/ai/pipeline.ts:232`), but nothing in the UI leads a user to it.

### 5. Password login fails for accounts that signed up with Gmail

Verified against the live project (`pwbktcfjxldtlndbvvil`) with
`scripts/diag-auth-identities.mjs`:

```
hakimkassama@gmail.com   identities=[google]         confirmed=yes
zkassama@googlemail.com  identities=[google]         confirmed=yes
emm247@gmail.com         identities=[email,google]   confirmed=yes
emmlaw247@gmail.com      identities=[email,google]   confirmed=yes
contact@scholarlens.ac   identities=[email]          confirmed=yes
```

Two accounts hold **only a `google` identity**. No email identity means no
password hash, so `signInWithPassword` returns exactly the reported error,
"Invalid login credentials". The accounts with both identities are the ones that
work — the correlation is exact.

How an account ends up google-only after what feels like an email signup: when
`supabase.auth.signUp()` is called for an address that already exists, Supabase
returns an **obfuscated success** rather than an error (user-enumeration
protection). It returns a user object with an empty `identities` array, sets no
password, and sends no new-account email. `app/(auth)/signup/page.tsx:28-30`
treats this as success and pushes to `/dashboard`; middleware bounces the
unauthenticated visitor to `/login`. The user believes they registered, and
their chosen password never existed.

Two aggravating factors, both confirmed absent from the codebase:

- **No password reset flow exists.** `resetPasswordForEmail` appears nowhere.
  A google-only user has no path to ever set a password.
- `signUp` passes no `emailRedirectTo` (`app/(auth)/signup/page.tsx:23-26`).

## Approach

The four usage defects are one design: **stop deriving usage, start recording
it.** A ledger table whose rows are not reachable by any cascade, written
through a reserve → commit → release lifecycle.

### Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| What is metered permanently | Reviews **and** manuscript slots | User requirement: deletion must never refund. |
| When a slot is charged | On the manuscript's **first completed review**, not at upload | Reconciles "deletion never refunds" with "a wrong upload must be free". |
| When a review credit is charged | Reserved at start, committed on completion, released on failure | A hold prevents overrun during the minutes a review runs; failed reviews stay free, as today. |
| Reset cycle | Paid plans reset on the billing anniversary; Free never resets | User's wording: "used up until next month subscription kicks in", and "free… is used once". |
| Free allowance | 2 reviews, lifetime | Keeps today's number, removes the recurrence. |
| Re-Review destination | The existing upload-a-revised-version flow | The pipeline already supports prior-draft comparison and score delta. |
| Existing accounts | Backfilled from surviving completed sessions | No surprise reset for current users. |

### Rejected alternatives

- **Blocking deletes / soft-delete only.** Retaining manuscripts forever to keep
  the count honest conflates a storage decision with a billing decision, and
  users have a legitimate right to delete their work.
- **Removing the cascades.** Orphaned `review_sessions` rows would keep
  referencing deleted drafts, corrupting every other query in the app.
- **Counting `review_sessions` with a `deleted_at` tombstone.** Still couples
  the meter to a table the user controls, and does not solve the charge-point
  problem.

## Architecture

### `usage_events` — the ledger

```sql
create table public.usage_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  kind text not null check (kind in ('review','manuscript_slot')),
  state text not null default 'reserved'
    check (state in ('reserved','consumed','released')),
  manuscript_id uuid,        -- deliberately NOT a foreign key
  review_session_id uuid,    -- deliberately NOT a foreign key
  window_start timestamptz not null,
  created_at timestamptz default now(),
  consumed_at timestamptz
);
```

**The absence of foreign keys on `manuscript_id` and `review_session_id` is the
entire point of this table.** They are soft references, kept for audit and
idempotency only. No cascade can reach a ledger row. A migration reviewer who
"fixes" them into real foreign keys reintroduces the original bug, so the
migration carries a comment saying so.

`user_id` *is* a real foreign key: deleting the account should delete the
ledger, and a deleted account cannot be logged into anyway.

Indexes:

```sql
create index idx_usage_events_user_kind_window
  on public.usage_events(user_id, kind, window_start);

-- A manuscript's slot is charged at most once, ever. This is what makes a
-- re-review cost a review credit but not a second slot.
create unique index idx_usage_events_one_slot_per_manuscript
  on public.usage_events(user_id, manuscript_id)
  where kind = 'manuscript_slot';
```

RLS: enable, with a select-own policy for read paths. All writes go through the
service-role admin client, matching how `lib/plan/gates.ts` already operates.

### Counting rule

**Used = rows in state `reserved` or `consumed`. `released` never counts.**

One rule, applied identically to both kinds. A reserved row counts because the
work is in flight; a released row does not because the work produced nothing.

### Lifecycle

| Moment | Code site | Ledger action |
|---|---|---|
| Review start | `app/api/review/start/route.ts` after the existing rate-limit checks | Insert `kind='review', state='reserved'`, then set `review_session_id` once the session row exists. Over limit → 403 `{ error, upgradeUrl: '/billing' }`. |
| Review retry | `app/api/review/retry/route.ts:38` | Insert a **new** `reserved` row for the same `review_session_id`. The prior attempt's row is already `released`, so it does not double-count, and the retry is visible in the audit trail. |
| Review completes | `lib/ai/pipeline.ts:178` (`runDeepReviewStage`, the only place `status: 'complete'` is written) | Flip the review row to `consumed` + `consumed_at`; **and** insert the `manuscript_slot` row for the session's manuscript, ignoring unique-violation (already charged). |
| Review fails | `lib/ai/pipeline.ts:97` and `lib/ai/pipeline.ts:200` | Flip to `released`. |
| Review reaped | `app/api/cron/reap-reviews/route.ts`, where the main `status` claim succeeds | Flip to `released`. Only for `lifecycle.column === 'status'` — the three sub-pipeline lifecycles never held a credit. |

`awaiting_confirmation` needs no special handling: the session is created (and
its credit reserved) at start, pauses for user confirmation, and resumes through
`runDeepReviewStage` via `/api/review/confirm`, which is already the commit
point.

### Module boundary

New `lib/plan/ledger.ts`, the only module that writes `usage_events`:

```ts
reserveReviewCredit(userId, sessionId?): Promise<{ ok: true; eventId: string } | { ok: false; used: number; limit: number; plan: string }>
attachSessionToReservation(eventId, sessionId): Promise<void>
commitReviewCredit(sessionId): Promise<void>   // also charges the manuscript slot
releaseReviewCredit(sessionId): Promise<void>
countUsage(userId, kind, windowStart): Promise<number>
```

Commit and release are **idempotent** — both are reachable more than once (a
retry after a reap, a pipeline that fails after partially completing). They
filter on the current state rather than assuming it.

`lib/plan/gates.ts` keeps its existing exported signatures and return shapes;
only the bodies change, so `app/api/billing/usage/route.ts`,
`app/api/manuscripts/route.ts`, and both review routes need no interface
changes.

### The two gate bodies

`checkReviewLimit`: drop the manuscripts → drafts → sessions walk entirely.
Count `usage_events` where `kind='review'`, `state in ('reserved','consumed')`,
`window_start >= <current window>`.

`checkManuscriptLimit`:

```
used = charged slots in the current window
     + live manuscripts (archived = false) that have no manuscript_slot row
```

The second term keeps storage bounded — an un-reviewed manuscript occupies a
slot while it exists and frees it on delete — while the first term is permanent.
A manuscript that has been reviewed and then deleted still counts through the
first term.

### Quota windows and the one-time Free plan

New column:

```sql
alter table public.plans add column if not exists quota_resets boolean not null default true;
update public.plans set quota_resets = false where id = 'free';
```

`quotaWindowStart` in `lib/plan/period.ts` gains two parameters, `resets:
boolean` and `accountCreatedAt: string` (from `profiles.created_at`, which
`getUserPlan` starts selecting). When `resets` is false it returns
`accountCreatedAt`, so the window spans the account's entire lifetime and every
event ever recorded counts. When true, its current behaviour is unchanged:
billing anniversary if `current_period_start` is set, calendar month otherwise.
It remains a pure function, so its existing unit tests extend rather than
change.

`max_reviews_per_month` stays `2` for `free`; its meaning becomes "2 total" for
non-resetting plans. The column is not renamed — it is referenced across gates,
the usage route, the billing page, and the plans table, and a rename is churn
without benefit. The semantics are documented at the column's read sites.

**Downgrade consequence, accepted:** a paid user who returns to Free is
immediately exhausted, because their lifetime total already exceeds 2. This
follows directly from "the free tier is used once".

### Exhausted-Free experience

Nothing about authentication or access changes. Middleware is untouched; the
account stays active; every past review, export, and PDF remains readable.

- `GET /api/billing/usage` already reports `used`/`limit`; the response gains
  `exhausted: boolean` and `resets: boolean` so the UI can distinguish "come
  back next month" from "upgrade to continue".
- `components/dashboard/UsageCard.tsx` renders an upgrade call-to-action instead
  of a progress bar when exhausted and non-resetting.
- The dashboard's "New review" and "Re-Review" buttons link to `/billing` with
  explanatory copy when exhausted.
- The API-side 403 with `upgradeUrl` is the existing pattern and stays as the
  authoritative enforcement — the UI change is convenience, not a gate.

### Re-Review

- `app/(dashboard)/dashboard/page.tsx` gains a second button beside "New
  review", labelled **Re-Review**, linking to `/manuscripts/re-review`.
- New `app/(dashboard)/manuscripts/re-review/page.tsx` lists manuscripts having
  at least one `complete` review session: title, last review date, last overall
  score. Selecting one navigates to the existing
  `/manuscripts/[id]/upload` new-version flow.
- Empty state: "No completed reviews yet" with a link to New review.
- The page reuses `ManuscriptCard` styling and the `pr-*` Tailwind tokens with
  shadcn components, per the project's design system.

A re-review consumes a review credit at completion, and no additional manuscript
slot — guaranteed by the partial unique index rather than by application logic.

### Authentication fixes

Four changes plus one recovery path:

1. **New `/forgot-password` and `/reset-password` pages.**
   `supabase.auth.resetPasswordForEmail(email, { redirectTo: <origin>/auth/callback?next=/reset-password })`,
   then `supabase.auth.updateUser({ password })` on the reset page. For a
   google-only account this **creates the email identity**, which is what makes
   the two affected users recoverable. `/reset-password` is added to the
   middleware's public prefixes; the recovery session arrives through the
   existing `/auth/callback` code exchange.
2. **Signup detects the obfuscated success.** After `signUp`, if
   `data.user && data.user.identities?.length === 0`, show "An account already
   exists for this email — log in, or continue with Google" and do **not**
   navigate to `/dashboard`.
3. **Signup stops assuming an immediate session.** Pass
   `emailRedirectTo: ${window.location.origin}/auth/callback`. When
   `data.session` is null, render "Check your email to confirm your account"
   rather than pushing to `/dashboard` for the middleware to bounce.
4. **Login maps the opaque error.** "Invalid login credentials" becomes a
   message naming both recovery routes: continue with Google, or reset your
   password. A "Forgot password?" link is added to the login card.

The two affected accounts recover by using Forgot Password once. No manual
database intervention, and no admin-side password setting.

`scripts/diag-auth-identities.mjs` (written during this investigation) is kept
as a standing diagnostic. It reads `.env.local` explicitly rather than trusting
`process.env`, because OS-level variables shadow the file on this machine and
have previously pointed scripts at the wrong Supabase project.

### Backfill

A one-time script, `scripts/backfill-usage-ledger.mjs`, following the existing
`scripts/backfill-plan-prices.mjs` pattern:

- For every `review_sessions` row with `status = 'complete'`, insert a
  `consumed` review event for its owner, with `window_start` computed from that
  user's plan and period, and `created_at`/`consumed_at` copied from the session
  so historical rows land in the correct window.
- For every manuscript with at least one complete session, insert one
  `consumed` `manuscript_slot` event.
- Idempotent: re-running inserts nothing new, enforced by checking
  `review_session_id` and by the slot unique index.

Reviews already deleted are unrecoverable and go uncounted — a deliberate
one-time amnesty, stated in the script's output.

## Data flow

```
POST /api/review/start
  ├─ resolveAuth → active-review lock → hourly cap        (unchanged)
  ├─ reserveReviewCredit(userId)
  │    ├─ windowStart = quotaWindowStart(periodStart, resets, createdAt)
  │    ├─ used = count(kind='review', state in reserved|consumed, window)
  │    └─ used >= limit → 403 { error, upgradeUrl }
  ├─ insert review_sessions (queued)
  ├─ attachSessionToReservation(eventId, sessionId)
  └─ runReviewPipeline(sessionId) via waitUntil
         ├─ complete  → commitReviewCredit(sessionId)
         │                ├─ review row  → consumed
         │                └─ slot row    → insert (unique index absorbs repeats)
         └─ failed    → releaseReviewCredit(sessionId) → released

DELETE /api/manuscripts/[id]
  └─ cascades through drafts → review_sessions
       └─ usage_events untouched: no foreign key reaches them
```

## Error handling

- **Reservation succeeds, session insert fails.** The reserved row would leak
  and permanently occupy a credit. The route releases the reservation in the
  error branch before returning 500.
- **Commit fails after the review completed.** The user got their review free.
  Logged at error level to Sentry; the reserved→consumed flip is retried once.
  Under-charging is the correct failure direction — never bill for output the
  user may not have received.
- **Double commit** (retry after a reap that already completed). The state
  filter makes the second call a no-op.
- **Concurrent starts racing the limit.** The existing one-active-review lock
  (`app/api/review/start/route.ts:47`) already serialises this per user, and a
  reservation is written before the pipeline begins.
- **Backfill run twice.** Idempotent by construction.
- **Free user hits the wall mid-session.** 403 with `upgradeUrl`; no partial
  state is written because the reservation is checked before the session insert.

## Testing

Unit (`tests/`, Vitest, mirroring `tests/planGates.test.ts`'s admin-client mock):

- `reserveReviewCredit` at, below, and over the limit.
- `commitReviewCredit` — flips state, charges the slot once, no-ops on repeat.
- `releaseReviewCredit` — released rows stop counting.
- `checkManuscriptLimit` — charged-but-deleted manuscripts still count; live
  un-reviewed ones count and stop on delete.
- `quotaWindowStart` with `resets: false` → account creation date.
- Free plan: 2 lifetime reviews, third refused, no reset after a month passes.
- Paid plan: resets on the billing anniversary (existing behaviour preserved).
- Super-admin bypass still returns `Infinity` for both gates.

**The regression test that defines this work:** run a review to completion,
delete the manuscript, assert `checkReviewLimit().used` is unchanged.

Manual verification: sign up with a fresh Gmail address, confirm, log in with
the password; attempt a second signup on the same address and confirm the
"account already exists" message; run Forgot Password against
`hakimkassama@gmail.com` and confirm password login then works.

Per project convention `npm test` is lenient, so the gate for every commit is
`npm run build`.

## Migrations

| File | Contents |
|---|---|
| `019_usage_events.sql` | The ledger table, indexes, RLS, and the comment explaining why two columns are intentionally not foreign keys. |
| `020_plan_quota_resets.sql` | `plans.quota_resets`, defaulted true, false for `free`. |

Per project convention, the migration is applied and the resulting **columns are
verified directly** — `schema_migrations` is not trusted as evidence in either
direction.

## Out of scope

- Renaming `max_reviews_per_month`.
- Account deletion as a quota-reset vector (there is no account-delete feature
  today; if one is added, the ledger's `on delete cascade` on `user_id` will
  need revisiting).
- Changing any plan's price or paid allowance.
- Team-plan seat metering.
