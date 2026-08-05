# Usage Ledger, One-Time Free Tier, Re-Review, and Auth Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record usage in a durable ledger that deleting a manuscript cannot refund, charge it on review completion rather than upload, make the Free tier a one-time allowance, add a Re-Review entry point, and give password-less Google accounts a way to sign in.

**Architecture:** A new `usage_events` table records every review credit and manuscript slot. Its `manuscript_id` and `review_session_id` columns are deliberately **not** foreign keys, so the `manuscripts → drafts → review_sessions` cascade cannot reach them. Credits move through reserve (at review start) → consumed (at completion) or released (on failure). `lib/plan/gates.ts` stops deriving usage from live rows and counts ledger rows instead.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres + GoTrue auth), Vitest, Tailwind with `pr-*` design tokens, shadcn/ui.

**Design doc:** `docs/superpowers/specs/2026-08-05-usage-ledger-free-tier-and-auth-design.md`

---

## Before you start

Read these three things — the plan assumes you know them:

1. **`npm test` is lenient in this project. The gate for every commit is `npm run build`.** Run it before each commit. If it fails, fix it before committing.
2. **Migrations are applied through the Supabase dashboard SQL editor** (or `psql` against the project). After applying one, **verify the columns exist by querying them** — the `schema_migrations` table is unreliable in this project and lies in both directions. Never treat it as evidence.
3. **The test mock in `tests/planGates.test.ts` gives one canned response per table per call.** Every function you write must query each table at most once per invocation, or the tests become unwritable. This constrains the implementations below, and they are written to respect it.

Environment note: OS-level environment variables shadow `.env.local` on this machine. Scripts in `scripts/` therefore parse `.env.local` explicitly rather than reading `process.env` — follow that pattern in Task 14. `scripts/diag-auth-identities.mjs` is a working example.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/019_usage_events.sql` | **Create.** The ledger table, indexes, RLS. |
| `supabase/migrations/020_plan_quota_resets.sql` | **Create.** `plans.quota_resets`, false for `free`. |
| `lib/plan/period.ts` | **Modify.** `quotaWindowStart` gains an optional third argument for non-resetting plans. |
| `lib/plan/ledger.ts` | **Create.** The only module that reads/writes `usage_events`. Owns quota-window resolution. |
| `lib/plan/gates.ts` | **Modify.** Limit checks count ledger rows. Public signatures unchanged except an added `windowStart`. |
| `app/api/review/start/route.ts` | **Modify.** Reserve a credit; release it if the session insert fails. |
| `app/api/review/retry/route.ts` | **Modify.** Reserve a fresh credit for the retry. |
| `lib/ai/pipeline.ts` | **Modify.** Commit on completion, release on both failure paths. |
| `app/api/cron/reap-reviews/route.ts` | **Modify.** Release when the main lifecycle is reaped. |
| `app/api/billing/usage/route.ts` | **Modify.** Report `exhausted` and `resets`. |
| `components/dashboard/UsageCard.tsx` | **Modify.** Upgrade call-to-action when a non-resetting plan is exhausted. |
| `components/dashboard/DashboardActions.tsx` | **Create.** The dashboard's action buttons; swaps to an upgrade prompt when a one-time plan is exhausted. |
| `app/(dashboard)/dashboard/page.tsx` | **Modify.** Render `DashboardActions` in place of the inline button. |
| `lib/manuscripts/reviewed.ts` | **Create.** Pure helper: which manuscripts have a completed review. |
| `app/(dashboard)/manuscripts/re-review/page.tsx` | **Create.** The Re-Review picker. |
| `scripts/backfill-usage-ledger.mjs` | **Create.** One-time backfill from surviving sessions. |
| `app/(auth)/forgot-password/page.tsx` | **Create.** Request a reset email. |
| `app/(auth)/reset-password/page.tsx` | **Create.** Set a new password (creates the email identity). |
| `middleware.ts` | **Modify.** Make the two new auth pages public. |
| `app/(auth)/signup/page.tsx` | **Modify.** Detect the already-registered obfuscated success. |
| `app/(auth)/login/page.tsx` | **Modify.** Map the opaque credential error; link to reset. |
| `tests/planPeriod.test.ts` | **Modify.** Non-resetting window cases. |
| `tests/planLedger.test.ts` | **Create.** Reserve/commit/release. |
| `tests/planGates.test.ts` | **Modify.** Rewrite both limit suites against the ledger. |
| `tests/manuscriptsReviewed.test.ts` | **Create.** The pure Re-Review filter. |

---

## Task 1: The ledger table

**Files:**
- Create: `supabase/migrations/019_usage_events.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/019_usage_events.sql`:

```sql
-- Durable usage ledger.
--
-- Usage used to be *derived*: checkReviewLimit walked manuscripts -> drafts ->
-- review_sessions and counted the sessions. Every link in that chain is
-- `on delete cascade`, so deleting a manuscript erased the evidence that its
-- reviews had ever run and handed the allowance back. Any plan could be used
-- indefinitely by deleting each manuscript afterwards.
--
-- This table records usage instead of inferring it.
--
-- !! manuscript_id and review_session_id are deliberately NOT foreign keys. !!
-- They are soft references kept for audit and idempotency only. Making them
-- real foreign keys would put these rows back inside the cascade and restore
-- the exact bug this table exists to fix. Do not "fix" them.
--
-- user_id IS a real foreign key: deleting the account should delete its ledger,
-- and a deleted account cannot be signed into.

create table if not exists public.usage_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  kind text not null check (kind in ('review','manuscript_slot')),
  state text not null default 'reserved'
    check (state in ('reserved','consumed','released')),
  manuscript_id uuid,        -- NOT a foreign key, on purpose (see above)
  review_session_id uuid,    -- NOT a foreign key, on purpose (see above)
  window_start timestamptz not null,
  created_at timestamptz default now(),
  consumed_at timestamptz
);

create index if not exists idx_usage_events_user_kind_window
  on public.usage_events(user_id, kind, window_start);

-- Lets commit/release find a session's reservation without a scan.
create index if not exists idx_usage_events_session
  on public.usage_events(review_session_id)
  where review_session_id is not null;

-- A manuscript's slot is charged at most once, ever. This is what makes a
-- re-review cost a review credit but never a second manuscript slot — enforced
-- by the database rather than by application logic.
create unique index if not exists idx_usage_events_one_slot_per_manuscript
  on public.usage_events(user_id, manuscript_id)
  where kind = 'manuscript_slot';

alter table public.usage_events enable row level security;

-- Reads only. Every write goes through the service-role admin client, matching
-- how lib/plan/gates.ts already operates.
drop policy if exists "users_read_own_usage" on public.usage_events;
create policy "users_read_own_usage" on public.usage_events
  for select using (auth.uid() = user_id);
```

- [ ] **Step 2: Apply the migration**

Paste the file's contents into the Supabase SQL editor for project `pwbktcfjxldtlndbvvil` and run it.

- [ ] **Step 3: Verify the table exists by querying it, not by trusting migration history**

Run in the SQL editor:

```sql
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'usage_events'
 order by ordinal_position;
```

Expected: 9 rows — `id, user_id, kind, state, manuscript_id, review_session_id, window_start, created_at, consumed_at`.

Then confirm the constraint that matters most is absent:

```sql
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'public.usage_events'::regclass and contype = 'f';
```

Expected: exactly **one** row, the `user_id` foreign key. If `manuscript_id` or `review_session_id` appear here, the migration was altered — fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/019_usage_events.sql
git commit -m "Add usage_events ledger table"
```

---

## Task 2: The `quota_resets` plan flag

**Files:**
- Create: `supabase/migrations/020_plan_quota_resets.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/020_plan_quota_resets.sql`:

```sql
-- Whether a plan's allowance renews.
--
-- The Free plan advertised max_reviews_per_month = 2 and was metered against
-- the calendar month, so it renewed forever and there was never a reason to
-- upgrade. Free is now a one-time allowance: 2 reviews for the lifetime of the
-- account, no rollover.
--
-- For plans with quota_resets = false, the quota window starts at the account's
-- creation date, so every event ever recorded counts. max_reviews_per_month and
-- max_manuscripts keep their names but mean "total, ever" for such plans.

alter table public.plans
  add column if not exists quota_resets boolean not null default true;

update public.plans set quota_resets = false where id = 'free';
```

- [ ] **Step 2: Apply the migration**

Run it in the Supabase SQL editor.

- [ ] **Step 3: Verify by querying the data**

```sql
select id, quota_resets, max_reviews_per_month, max_manuscripts from public.plans order by id;
```

Expected: `free` has `quota_resets = false`; `starter`, `pro`, `team` have `true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/020_plan_quota_resets.sql
git commit -m "Add plans.quota_resets; Free no longer renews"
```

---

## Task 3: Lifetime quota windows

`quotaWindowStart` currently takes `(periodStartIso, now)`. The third argument is **optional** so all existing call sites and all existing tests keep working unchanged.

**Files:**
- Modify: `lib/plan/period.ts:50`
- Test: `tests/planPeriod.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/planPeriod.test.ts`, inside the existing `describe('quotaWindowStart', ...)` block:

```ts
  it('spans the whole account lifetime when the plan does not reset', () => {
    // Free is a one-time allowance: the window starts the day the account was
    // created, so every event ever recorded still counts.
    const created = '2025-11-03T08:30:00.000Z'
    expect(
      quotaWindowStart(null, at('2026-07-30T12:00:00Z'), {
        resets: false,
        accountCreatedAt: created,
      }).toISOString()
    ).toBe(created)
  })

  it('ignores a billing anchor entirely when the plan does not reset', () => {
    // A downgraded account can still carry current_period_start from its paid
    // days; a non-resetting plan must not honour it.
    const created = '2025-11-03T08:30:00.000Z'
    expect(
      quotaWindowStart('2026-07-28T09:15:00.000Z', at('2026-07-30T12:00:00Z'), {
        resets: false,
        accountCreatedAt: created,
      }).toISOString()
    ).toBe(created)
  })

  it('falls back to the calendar month when non-resetting but the creation date is unusable', () => {
    expect(
      quotaWindowStart(null, at('2026-07-30T12:00:00Z'), {
        resets: false,
        accountCreatedAt: null,
      }).toISOString()
    ).toBe('2026-07-01T00:00:00.000Z')
  })

  it('behaves exactly as before when resets is true', () => {
    const anchor = '2026-07-28T09:15:00.000Z'
    expect(
      quotaWindowStart(anchor, at('2026-07-30T12:00:00Z'), {
        resets: true,
        accountCreatedAt: '2025-01-01T00:00:00.000Z',
      }).toISOString()
    ).toBe(anchor)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/planPeriod.test.ts`
Expected: FAIL — the new cases return the calendar month or the anchor because the third argument is ignored.

- [ ] **Step 3: Implement**

In `lib/plan/period.ts`, replace the `quotaWindowStart` function (currently at line 50) with:

```ts
/**
 * @param periodStartIso `subscriptions.current_period_start`, or null/absent for
 *   free-plan rows and rows not yet re-synced since migration 017.
 * @param now the instant to evaluate against.
 * @param opts `resets: false` marks a one-time plan (the Free tier). Its window
 *   begins at `accountCreatedAt` and never moves, so every event ever recorded
 *   counts and the allowance never renews. Omitted entirely by callers that
 *   predate migration 020, which keeps the original two-argument behaviour.
 * @returns the instant the caller's current quota window began. Falls back to
 *   the calendar month when there is no usable anchor.
 */
export function quotaWindowStart(
  periodStartIso: string | null | undefined,
  now: Date,
  opts?: { resets?: boolean; accountCreatedAt?: string | null },
): Date {
  // A non-resetting plan ignores the billing anchor completely — a downgraded
  // account can still carry current_period_start from when it was paying.
  if (opts?.resets === false) {
    const created = opts.accountCreatedAt ? new Date(opts.accountCreatedAt) : null
    if (created && !Number.isNaN(created.getTime())) return created
    return calendarMonthStart(now)
  }

  if (!periodStartIso) return calendarMonthStart(now)

  const anchor = new Date(periodStartIso)
  if (Number.isNaN(anchor.getTime())) return calendarMonthStart(now)

  // A period that hasn't begun yet (clock skew, or a scheduled change written
  // ahead of time): nothing can have been used in it, so count from the anchor.
  if (anchor.getTime() > now.getTime()) return anchor

  const monthsElapsed =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth())

  // Month-difference alone overshoots when `now` is earlier in the month than
  // the anchor day (anchor 31 Jan, now 28 Feb → the window is still January's).
  const candidate = addMonthsUtc(anchor, monthsElapsed)
  return candidate.getTime() > now.getTime() ? addMonthsUtc(anchor, monthsElapsed - 1) : candidate
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/planPeriod.test.ts`
Expected: PASS, including every pre-existing case (the two-argument form is untouched).

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add lib/plan/period.ts tests/planPeriod.test.ts
git commit -m "quotaWindowStart: support non-resetting (one-time) plans"
```

---

## Task 4: The ledger module — context and counting

`lib/plan/ledger.ts` becomes the only module that touches `usage_events`, and it also owns quota-window resolution so `gates.ts` can drop its private `getUserPlan`. Dependencies run one way: `gates.ts` imports `ledger.ts`, never the reverse.

**Files:**
- Create: `lib/plan/ledger.ts`
- Test: `tests/planLedger.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/planLedger.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

// Mock the service-role client so the real lib/supabase/admin (which imports
// 'server-only') never loads under Vitest, matching tests/planGates.test.ts.
// Each table gets one canned response per test; every function under test
// queries a given table at most once per call.
function mockAdmin(responses: Record<string, unknown>, calls: Record<string, unknown>[] = []) {
  return {
    from: vi.fn((table: string) => {
      const result = responses[table] ?? { data: null, count: 0 }
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'gte', 'in', 'order', 'neq', 'is']) {
        builder[m] = vi.fn(() => builder)
      }
      builder.insert = vi.fn((row: unknown) => {
        calls.push({ table, op: 'insert', row })
        return builder
      })
      builder.update = vi.fn((patch: unknown) => {
        calls.push({ table, op: 'update', patch })
        return builder
      })
      builder.single = vi.fn(async () => result)
      builder.maybeSingle = vi.fn(async () => result)
      ;(builder as unknown as PromiseLike<unknown>).then = (resolve: (v: unknown) => void) =>
        resolve(result)
      return builder
    }),
  }
}

const h = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof mockAdmin> }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }))

import { resolveQuotaContext, countUsage } from '@/lib/plan/ledger'

describe('resolveQuotaContext', () => {
  it('uses the billing anniversary for a resetting plan', async () => {
    h.admin = mockAdmin({
      subscriptions: {
        data: {
          plan_id: 'pro',
          current_period_start: '2026-07-28T09:15:00.000Z',
          plans: { quota_resets: true, max_reviews_per_month: 30 },
        },
      },
      profiles: { data: { created_at: '2025-01-01T00:00:00.000Z' } },
    })
    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))
    expect(ctx.planId).toBe('pro')
    expect(ctx.windowStart.toISOString()).toBe('2026-07-28T09:15:00.000Z')
  })

  it('uses the account creation date for a non-resetting plan', async () => {
    h.admin = mockAdmin({
      subscriptions: {
        data: {
          plan_id: 'free',
          current_period_start: null,
          plans: { quota_resets: false, max_reviews_per_month: 2 },
        },
      },
      profiles: { data: { created_at: '2025-11-03T08:30:00.000Z' } },
    })
    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))
    expect(ctx.planId).toBe('free')
    expect(ctx.windowStart.toISOString()).toBe('2025-11-03T08:30:00.000Z')
  })

  it('defaults to the free plan when there is no subscription row', async () => {
    h.admin = mockAdmin({
      subscriptions: { data: null },
      profiles: { data: { created_at: '2025-11-03T08:30:00.000Z' } },
    })
    const ctx = await resolveQuotaContext('u1', new Date('2026-07-30T12:00:00Z'))
    expect(ctx.planId).toBe('free')
    expect(ctx.plan).toBeNull()
  })
})

describe('countUsage', () => {
  it('counts reserved and consumed rows in the window', async () => {
    h.admin = mockAdmin({ usage_events: { count: 3 } })
    await expect(
      countUsage('u1', 'review', new Date('2026-07-01T00:00:00Z'))
    ).resolves.toBe(3)
  })

  it('returns 0 when the query yields no count', async () => {
    h.admin = mockAdmin({ usage_events: { count: null } })
    await expect(
      countUsage('u1', 'review', new Date('2026-07-01T00:00:00Z'))
    ).resolves.toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/planLedger.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/plan/ledger'".

- [ ] **Step 3: Implement**

Create `lib/plan/ledger.ts`:

```ts
import { createAdminClient } from '@/lib/supabase/admin'
import { quotaWindowStart } from '@/lib/plan/period'

/**
 * The durable usage ledger.
 *
 * This is the only module that reads or writes `usage_events`. Usage is
 * recorded here rather than derived from `review_sessions`, because those rows
 * cascade away when a manuscript is deleted and took the user's spent
 * allowance with them.
 *
 * Counting rule, applied identically to both kinds:
 *   used = rows in state 'reserved' or 'consumed'.  'released' never counts.
 *
 * A reserved row counts because the work is in flight; a released row does not
 * because the work produced nothing.
 */

export type UsageKind = 'review' | 'manuscript_slot'

/** States that occupy an allowance. Exported so callers cannot drift from it. */
export const OCCUPYING_STATES = ['reserved', 'consumed'] as const

export interface QuotaContext {
  planId: string
  plan: Record<string, unknown> | null
  windowStart: Date
}

/**
 * Resolve the caller's plan and the instant their current quota window began.
 *
 * Queries `subscriptions` and `profiles` exactly once each, which is what keeps
 * this testable against the one-response-per-table mock.
 */
export async function resolveQuotaContext(userId: string, now = new Date()): Promise<QuotaContext> {
  const admin = createAdminClient()

  const [{ data: sub }, { data: profile }] = await Promise.all([
    admin
      .from('subscriptions')
      .select('plan_id, current_period_start, plans(*)')
      .eq('user_id', userId)
      .maybeSingle(),
    admin.from('profiles').select('created_at').eq('id', userId).maybeSingle(),
  ])

  const plan = (sub?.plans as unknown as Record<string, unknown> | null) ?? null

  // Absent flag means a plans row predating migration 020 — those all reset.
  const resets = plan ? plan.quota_resets !== false : true

  return {
    planId: (sub?.plan_id as string | undefined) ?? 'free',
    plan,
    windowStart: quotaWindowStart(
      (sub?.current_period_start as string | null | undefined) ?? null,
      now,
      { resets, accountCreatedAt: (profile?.created_at as string | undefined) ?? null },
    ),
  }
}

/** How much of `kind` the user has occupied since `windowStart`. */
export async function countUsage(
  userId: string,
  kind: UsageKind,
  windowStart: Date,
): Promise<number> {
  const admin = createAdminClient()
  const { count } = await admin
    .from('usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .in('state', OCCUPYING_STATES as unknown as string[])
    .gte('window_start', windowStart.toISOString())
  return count ?? 0
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/planLedger.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add lib/plan/ledger.ts tests/planLedger.test.ts
git commit -m "Add usage ledger: quota context resolution and counting"
```

---

## Task 5: Reserve, commit, release

Three writes. Commit and release are **idempotent** — both are reachable more than once (a retry after a reap; a pipeline that fails after partially completing), so both filter on the current state rather than assuming it.

**Files:**
- Modify: `lib/plan/ledger.ts`
- Test: `tests/planLedger.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/planLedger.test.ts`. Add the new names to the existing import line so it reads:

```ts
import {
  resolveQuotaContext,
  countUsage,
  insertReservation,
  releaseReviewCredit,
  commitReviewCredit,
} from '@/lib/plan/ledger'
```

Then append these suites:

```ts
describe('insertReservation', () => {
  it('writes a reserved review row and returns its id', async () => {
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin({ usage_events: { data: { id: 'evt-1' } } }, calls)

    const id = await insertReservation('u1', new Date('2026-07-01T00:00:00Z'), 'sess-1')

    expect(id).toBe('evt-1')
    expect(calls).toEqual([
      {
        table: 'usage_events',
        op: 'insert',
        row: {
          user_id: 'u1',
          kind: 'review',
          state: 'reserved',
          review_session_id: 'sess-1',
          window_start: '2026-07-01T00:00:00.000Z',
        },
      },
    ])
  })
})

describe('releaseReviewCredit', () => {
  it('releases only the reservation still held for that session', async () => {
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin({ usage_events: { data: [] } }, calls)

    await releaseReviewCredit('sess-1')

    // The eq('state','reserved') filter is what makes this idempotent: calling
    // it twice matches zero rows the second time.
    expect(calls).toEqual([
      { table: 'usage_events', op: 'update', patch: { state: 'released' } },
    ])
  })
})

describe('commitReviewCredit', () => {
  it('consumes the review credit and charges the manuscript slot', async () => {
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin({ usage_events: { data: [], error: null } }, calls)

    await commitReviewCredit({
      sessionId: 'sess-1',
      userId: 'u1',
      manuscriptId: 'man-1',
      windowStart: new Date('2026-07-01T00:00:00Z'),
    })

    expect(calls[0]).toMatchObject({ table: 'usage_events', op: 'update' })
    expect((calls[0] as { patch: { state: string } }).patch.state).toBe('consumed')
    expect(calls[1]).toEqual({
      table: 'usage_events',
      op: 'insert',
      row: {
        user_id: 'u1',
        kind: 'manuscript_slot',
        state: 'consumed',
        manuscript_id: 'man-1',
        window_start: '2026-07-01T00:00:00.000Z',
        consumed_at: expect.any(String),
      },
    })
  })

  it('swallows the unique violation when the slot was already charged', async () => {
    // A re-review hits the partial unique index. That is the mechanism that
    // makes a re-review cost a credit but not a second slot — not an error.
    const calls: Record<string, unknown>[] = []
    h.admin = mockAdmin({ usage_events: { data: null, error: { code: '23505' } } }, calls)

    await expect(
      commitReviewCredit({
        sessionId: 'sess-2',
        userId: 'u1',
        manuscriptId: 'man-1',
        windowStart: new Date('2026-07-01T00:00:00Z'),
      })
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/planLedger.test.ts`
Expected: FAIL — `insertReservation`, `releaseReviewCredit`, `commitReviewCredit` are not exported.

- [ ] **Step 3: Implement**

Append to `lib/plan/ledger.ts`:

```ts
/**
 * Hold a review credit before the pipeline starts.
 *
 * The hold is what prevents an overrun during the minutes a review runs. The
 * caller must have already confirmed availability via checkReviewLimit.
 */
export async function insertReservation(
  userId: string,
  windowStart: Date,
  sessionId: string | null,
): Promise<string | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('usage_events')
    .insert({
      user_id: userId,
      kind: 'review',
      state: 'reserved',
      review_session_id: sessionId,
      window_start: windowStart.toISOString(),
    })
    .select('id')
    .single()
  return (data?.id as string | undefined) ?? null
}

/** Attach a session to a reservation made before the session row existed. */
export async function attachSessionToReservation(
  eventId: string,
  sessionId: string,
): Promise<void> {
  const admin = createAdminClient()
  await admin.from('usage_events').update({ review_session_id: sessionId }).eq('id', eventId)
}

/**
 * Give the credit back. A review that produced nothing must not be charged —
 * whether it failed normally or was reaped after its process died.
 *
 * Idempotent: the state filter means a second call matches zero rows.
 */
export async function releaseReviewCredit(sessionId: string): Promise<void> {
  const admin = createAdminClient()
  await admin
    .from('usage_events')
    .update({ state: 'released' })
    .eq('review_session_id', sessionId)
    .eq('kind', 'review')
    .eq('state', 'reserved')
}

/**
 * Spend the credit, and charge the manuscript's slot if this is the first
 * review it has completed.
 *
 * The slot insert races against the partial unique index rather than checking
 * first — a re-review is *expected* to violate it, and letting the database
 * decide removes a check-then-act race between concurrent reviews.
 *
 * Idempotent, and deliberately never throws: by the time this runs the user
 * already has their review. Failing to charge under-bills, which is the correct
 * direction to fail. The caller reports the error.
 */
export async function commitReviewCredit(args: {
  sessionId: string
  userId: string
  manuscriptId: string
  windowStart: Date
}): Promise<void> {
  const admin = createAdminClient()

  await admin
    .from('usage_events')
    .update({ state: 'consumed', consumed_at: new Date().toISOString() })
    .eq('review_session_id', args.sessionId)
    .eq('kind', 'review')
    .eq('state', 'reserved')

  const { error } = await admin.from('usage_events').insert({
    user_id: args.userId,
    kind: 'manuscript_slot',
    state: 'consumed',
    manuscript_id: args.manuscriptId,
    window_start: args.windowStart.toISOString(),
    consumed_at: new Date().toISOString(),
  })

  // 23505 = unique_violation: the slot was already charged by an earlier review
  // of the same manuscript. Expected on every re-review.
  if (error && error.code !== '23505') throw error
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/planLedger.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add lib/plan/ledger.ts tests/planLedger.test.ts
git commit -m "Add ledger reserve, commit, and release operations"
```

---

## Task 6: `checkReviewLimit` counts the ledger

This is the task that fixes the reported bug. `checkReviewLimit` stops walking `manuscripts → drafts → review_sessions` entirely.

The return shape gains `windowStart`, so the review routes can reserve against the same window the check used without resolving it a second time. The existing tests use `toEqual` and will fail on the extra key — they are rewritten here, deliberately.

**Files:**
- Modify: `lib/plan/gates.ts:74-116` (and `getUserPlan` at `:28-39`)
- Test: `tests/planGates.test.ts:84-134`

- [ ] **Step 1: Write the failing tests**

In `tests/planGates.test.ts`, replace the whole `describe('checkReviewLimit', ...)` block with:

```ts
describe('checkReviewLimit', () => {
  const WINDOW = '2026-07-01T00:00:00.000Z'

  // resolveQuotaContext is exercised in tests/planLedger.test.ts. Mocking it
  // here keeps each gate test to one canned response per table.
  function mockCtx(planId: string, plan: Record<string, unknown> | null) {
    return { planId, plan, windowStart: new Date(WINDOW) }
  }

  it('allows when under the cap', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 2 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('starter', { max_reviews_per_month: 4 }))
    await expect(checkReviewLimit('u1')).resolves.toEqual({
      allowed: true, used: 2, limit: 4, plan: 'starter', windowStart: new Date(WINDOW),
    })
  })

  it('blocks at the cap', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 2 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('free', { max_reviews_per_month: 2 }))
    await expect(checkReviewLimit('u1')).resolves.toEqual({
      allowed: false, used: 2, limit: 2, plan: 'free', windowStart: new Date(WINDOW),
    })
  })

  it('treats a null limit as unlimited', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 99 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('team', { max_reviews_per_month: null }))
    const result = await checkReviewLimit('u1')
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(Number.POSITIVE_INFINITY)
  })

  it('defaults to 2 when there is no plan row at all', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, usage_events: { count: 0 } })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('free', null))
    await expect(checkReviewLimit('u1')).resolves.toMatchObject({ allowed: true, used: 0, limit: 2 })
  })

  it('bypasses the gate for a super admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkReviewLimit('u1')).resolves.toMatchObject({ allowed: true, plan: 'super_admin' })
  })

  it('counts the ledger, not review_sessions — deleting a manuscript refunds nothing', async () => {
    // THE REGRESSION TEST FOR THIS ENTIRE CHANGE.
    //
    // The old implementation walked manuscripts -> drafts -> review_sessions,
    // all of which cascade on delete, so a deleted manuscript handed the
    // allowance back. Here the manuscript, its drafts and its sessions are all
    // gone — and the user is still correctly at their cap, because the ledger
    // is not reachable by that cascade.
    h.admin = mockAdmin({
      user_roles: notSuperAdmin,
      manuscripts: { data: [], count: 0 },
      drafts: { data: [] },
      review_sessions: { count: 0 },
      usage_events: { count: 2 },
    })
    ledger.resolveQuotaContext.mockResolvedValue(mockCtx('free', { max_reviews_per_month: 2 }))

    const result = await checkReviewLimit('u1')

    expect(result.used).toBe(2)
    expect(result.allowed).toBe(false)
    // And prove it never consulted the cascading tables at all.
    const tables = h.admin.from.mock.calls.map((c) => c[0])
    expect(tables).not.toContain('drafts')
    expect(tables).not.toContain('review_sessions')
  })
})
```

At the top of `tests/planGates.test.ts`, after the existing `vi.mock('@/lib/supabase/admin', ...)` line (currently line 32), add the ledger mock:

```ts
const ledger = vi.hoisted(() => ({
  resolveQuotaContext: vi.fn(),
  chargedSlotManuscriptIds: vi.fn(),
}))
// Only the two context helpers are stubbed. `countUsage` runs for real against
// the mocked admin client — asserting on its query is part of the point.
vi.mock('@/lib/plan/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/ledger')>()),
  resolveQuotaContext: ledger.resolveQuotaContext,
}))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/planGates.test.ts`
Expected: FAIL — the results lack `windowStart`, and the regression test finds `drafts` and `review_sessions` among the queried tables.

- [ ] **Step 3: Implement**

In `lib/plan/gates.ts`, replace the import block at the top:

```ts
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveQuotaContext, countUsage } from '@/lib/plan/ledger'
```

Delete the private `getUserPlan` function (lines 28-39) — `resolveQuotaContext` replaces it — and replace `checkReviewLimit` with:

```ts
/**
 * Monthly review gate. Counts the durable ledger, never `review_sessions`.
 *
 * The old implementation walked manuscripts -> drafts -> review_sessions; every
 * link cascades on delete, so deleting a manuscript refunded the allowance.
 * Nothing here is reachable by that cascade.
 *
 * `windowStart` is returned so the caller can reserve against the same window
 * this check used, without resolving it a second time.
 */
export async function checkReviewLimit(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number; plan: string; windowStart: Date }> {
  if (await isSuperAdmin(userId)) {
    return {
      allowed: true,
      used: 0,
      limit: Number.POSITIVE_INFINITY,
      plan: 'super_admin',
      windowStart: new Date(0),
    }
  }

  const { planId, plan, windowStart } = await resolveQuotaContext(userId)
  // `?? 2` would also fire on an explicit `null` (unlimited) — only default
  // when there's no plan row at all.
  const rawLimit = plan ? (plan.max_reviews_per_month as number | null) : 2
  if (rawLimit === null) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: planId, windowStart }
  }

  const used = await countUsage(userId, 'review', windowStart)
  return { allowed: used < rawLimit, used, limit: rawLimit, plan: planId, windowStart }
}
```

Also update `checkFeatureGate` (currently at line 119) to use the new resolver — its body's `getUserPlan` call no longer exists:

```ts
/** Feature-flag gate: adversarial review, journal matching, PDF reports. */
export async function checkFeatureGate(
  userId: string,
  feature: PlanFeature
): Promise<{ allowed: boolean; plan: string }> {
  if (await isSuperAdmin(userId)) return { allowed: true, plan: 'super_admin' }

  const { planId, plan } = await resolveQuotaContext(userId)
  return { allowed: isFeatureAllowed(plan, feature), plan: planId }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/planGates.test.ts`
Expected: PASS. `checkManuscriptLimit`'s suite still passes because Task 7 has not changed it yet — if it fails here because `checkFeatureGate`'s mock now needs `resolveQuotaContext`, add `ledger.resolveQuotaContext.mockResolvedValue(...)` to the `checkFeatureGate` tests the same way.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add lib/plan/gates.ts tests/planGates.test.ts
git commit -m "checkReviewLimit counts the ledger; deleting a manuscript no longer refunds"
```

---

## Task 7: `checkManuscriptLimit` counts charged slots plus live un-reviewed

```
used = manuscripts charged in the current window
     + live manuscripts that have never been charged
```

The second term bounds storage — an un-reviewed manuscript occupies a slot while it exists and frees it on delete, which is what makes a mis-upload free. The first term is permanent.

**Files:**
- Modify: `lib/plan/gates.ts:46-71`
- Modify: `lib/plan/ledger.ts` (add `chargedSlotManuscriptIds`)
- Test: `tests/planGates.test.ts:48-82`

- [ ] **Step 1: Write the failing tests**

In `tests/planGates.test.ts`, replace the whole `describe('checkManuscriptLimit', ...)` block with:

```ts
describe('checkManuscriptLimit', () => {
  const WINDOW = '2026-07-01T00:00:00.000Z'
  const ctx = (planId: string, plan: Record<string, unknown> | null) => ({
    planId, plan, windowStart: new Date(WINDOW),
  })

  it('counts a live un-reviewed manuscript', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [{ id: 'm1' }] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('starter', { max_manuscripts: 2 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({ inWindow: new Set(), ever: new Set() })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({
      allowed: true, used: 1, limit: 2, plan: 'starter',
    })
  })

  it('still counts a reviewed manuscript after it has been deleted', async () => {
    // The manuscript row is gone. The charge is not.
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('free', { max_manuscripts: 1 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({
      inWindow: new Set(['deleted-m']), ever: new Set(['deleted-m']),
    })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({
      allowed: false, used: 1, limit: 1,
    })
  })

  it('does not double-count a manuscript that is both live and charged', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [{ id: 'm1' }] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('starter', { max_manuscripts: 5 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({
      inWindow: new Set(['m1']), ever: new Set(['m1']),
    })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({ used: 1 })
  })

  it('does not re-charge a manuscript charged in an earlier window', async () => {
    // Charged last month, still on disk: it is neither this window's charge nor
    // an uncharged live manuscript, so it costs nothing now.
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [{ id: 'old' }] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('pro', { max_manuscripts: 100 }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({
      inWindow: new Set(), ever: new Set(['old']),
    })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({ used: 0 })
  })

  it('treats a null limit as unlimited', async () => {
    h.admin = mockAdmin({ user_roles: notSuperAdmin, manuscripts: { data: [] } })
    ledger.resolveQuotaContext.mockResolvedValue(ctx('team', { max_manuscripts: null }))
    ledger.chargedSlotManuscriptIds.mockResolvedValue({ inWindow: new Set(), ever: new Set() })
    const result = await checkManuscriptLimit('u1')
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(Number.POSITIVE_INFINITY)
  })

  it('bypasses the gate for a super admin', async () => {
    h.admin = mockAdmin({ user_roles: superAdmin })
    await expect(checkManuscriptLimit('u1')).resolves.toMatchObject({ allowed: true, plan: 'super_admin' })
  })
})
```

Extend the ledger mock at the top of the file to expose the new function:

```ts
vi.mock('@/lib/plan/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/ledger')>()),
  resolveQuotaContext: ledger.resolveQuotaContext,
  chargedSlotManuscriptIds: ledger.chargedSlotManuscriptIds,
}))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/planGates.test.ts`
Expected: FAIL — `chargedSlotManuscriptIds` is not exported from the ledger, and `checkManuscriptLimit` still counts rows directly.

- [ ] **Step 3: Implement the ledger helper**

Append to `lib/plan/ledger.ts`:

```ts
/**
 * Which of the user's manuscripts have had their slot charged.
 *
 * Returns two sets from a single query:
 *   - `inWindow`: charged during the current quota window — these count now.
 *   - `ever`: charged at any time — these are not "live but uncharged", so a
 *     manuscript reviewed in a previous window costs nothing this window.
 *
 * One query, because per-user slot volumes are small (bounded by the plan's
 * manuscript cap) and a second round trip buys nothing.
 */
export async function chargedSlotManuscriptIds(
  userId: string,
  windowStart: Date,
): Promise<{ inWindow: Set<string>; ever: Set<string> }> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('usage_events')
    .select('manuscript_id, window_start')
    .eq('user_id', userId)
    .eq('kind', 'manuscript_slot')
    .in('state', OCCUPYING_STATES as unknown as string[])

  const inWindow = new Set<string>()
  const ever = new Set<string>()
  for (const row of (data ?? []) as { manuscript_id: string | null; window_start: string }[]) {
    if (!row.manuscript_id) continue
    ever.add(row.manuscript_id)
    if (new Date(row.window_start).getTime() >= windowStart.getTime()) {
      inWindow.add(row.manuscript_id)
    }
  }
  return { inWindow, ever }
}
```

- [ ] **Step 4: Implement the gate**

In `lib/plan/gates.ts`, replace `checkManuscriptLimit` (lines 46-71) with:

```ts
/**
 * Manuscript slot gate.
 *
 *   used = manuscripts charged in this window
 *        + live manuscripts that have never been charged
 *
 * A slot is charged when a manuscript's first review *completes*, so uploading
 * the wrong file and deleting it costs nothing. Once charged, deleting the
 * manuscript never refunds — the charge lives in the ledger, which no cascade
 * reaches. The second term keeps storage bounded without charging for it.
 */
export async function checkManuscriptLimit(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number; plan: string }> {
  if (await isSuperAdmin(userId)) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: 'super_admin' }
  }

  const { planId, plan, windowStart } = await resolveQuotaContext(userId)
  // `?? 1` would also fire on an explicit `null` (unlimited) — only default
  // when there's no plan row at all.
  const rawLimit = plan ? (plan.max_manuscripts as number | null) : 1
  if (rawLimit === null) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY, plan: planId }
  }

  const admin = createAdminClient()
  const [{ data: live }, charged] = await Promise.all([
    admin.from('manuscripts').select('id').eq('user_id', userId).eq('archived', false),
    chargedSlotManuscriptIds(userId, windowStart),
  ])

  const liveUncharged = ((live ?? []) as { id: string }[]).filter((m) => !charged.ever.has(m.id))
  const used = charged.inWindow.size + liveUncharged.length

  return { allowed: used < rawLimit, used, limit: rawLimit, plan: planId }
}
```

Update the import line in `lib/plan/gates.ts` to pull in the new helper:

```ts
import { resolveQuotaContext, countUsage, chargedSlotManuscriptIds } from '@/lib/plan/ledger'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/planGates.test.ts tests/planLedger.test.ts`
Expected: PASS.

- [ ] **Step 6: Build and commit**

```bash
npm run build
git add lib/plan/gates.ts lib/plan/ledger.ts tests/planGates.test.ts
git commit -m "checkManuscriptLimit: permanent slots for reviewed manuscripts"
```

---

## Task 8: Reserve a credit when a review starts

**Files:**
- Modify: `app/api/review/start/route.ts:67-100`

- [ ] **Step 1: Add the reservation**

In `app/api/review/start/route.ts`, add to the imports:

```ts
import { insertReservation, releaseReviewCredit, attachSessionToReservation } from '@/lib/plan/ledger'
```

Replace everything from the `// 3) the plan's monthly review cap` comment (line 67) through the `if (!session?.id)` guard (line 86) with:

```ts
  // 3) the plan's monthly review cap (business limit, distinct from the hourly abuse cap above)
  const planLimit = await checkReviewLimit(userId)
  if (!planLimit.allowed) {
    const planName = planLimit.plan[0].toUpperCase() + planLimit.plan.slice(1)
    return NextResponse.json(
      { error: `Monthly review limit reached (${planLimit.used}/${planLimit.limit} on the ${planName} plan)`, upgradeUrl: '/billing' },
      { status: 403 }
    )
  }

  // Hold the credit before the pipeline starts. Reserved against the same
  // window the check above used, so a window roll mid-request cannot let two
  // requests through on one credit.
  const reservationId = await insertReservation(userId, planLimit.windowStart, null)

  const { data: session, error } = await supabase
    .from('review_sessions')
    .insert({ draft_id: draftId, mode, status: 'queued' })
    .select()
    .single()

  // A leaked reservation would occupy a credit forever, so both failure paths
  // hand it back before returning.
  if (error || !session?.id) {
    if (reservationId) {
      await createAdminClient().from('usage_events').delete().eq('id', reservationId)
    }
    return NextResponse.json(
      { error: error?.message ?? 'Failed to create review session' },
      { status: 500 }
    )
  }

  if (reservationId) await attachSessionToReservation(reservationId, session.id)
```

Note the `releaseReviewCredit` import is unused in this file after the rewrite — drop it from the import line, leaving:

```ts
import { insertReservation, attachSessionToReservation } from '@/lib/plan/ledger'
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/review/start/route.ts
git commit -m "Reserve a review credit when a review starts"
```

---

## Task 9: Commit on completion, release on failure

**Files:**
- Modify: `lib/ai/pipeline.ts:96-99`, `:171-182`, `:199-202`

- [ ] **Step 1: Add the imports**

At the top of `lib/ai/pipeline.ts`, add:

```ts
import { commitReviewCredit, releaseReviewCredit, resolveQuotaContext } from '@/lib/plan/ledger'
```

- [ ] **Step 2: Release on the routing-stage failure**

In `runReviewPipeline`'s catch block, after the existing `status: 'failed'` update (line 96-99), add:

```ts
    await supabase.from('review_sessions').update({
      status: 'failed',
      error_message: message,
    }).eq('id', sessionId)
    // A review that produced nothing must not be charged.
    await releaseReviewCredit(sessionId)
    throw err
```

- [ ] **Step 3: Commit the credit when the review completes**

In `runDeepReviewStage`, immediately after the `mustWrite('persist review result', ...)` call (which ends at line 182) and **before** the `runProgressComparison` block, insert:

```ts
    // The review exists and the user has it — spend the credit now, and charge
    // the manuscript's slot if this is its first completed review.
    //
    // Deliberately not wrapped in mustWrite: by this point the user already has
    // their review, so failing to charge under-bills rather than losing work.
    // That is the correct direction to fail; report it and carry on.
    try {
      const { windowStart } = await resolveQuotaContext(manuscript.user_id)
      await commitReviewCredit({
        sessionId,
        userId: manuscript.user_id,
        manuscriptId: manuscript.id,
        windowStart,
      })
    } catch (e) {
      reportError(e, { sessionId, stage: 'usage commit', manuscriptId: manuscript.id })
    }
```

- [ ] **Step 4: Release on the deep-review failure**

In `runDeepReviewStage`'s catch block, after the existing `status: 'failed'` update (lines 199-202), add the release the same way:

```ts
    await supabase.from('review_sessions').update({
      status: 'failed',
      error_message: message,
    }).eq('id', sessionId)
    await releaseReviewCredit(sessionId)
    throw err
```

- [ ] **Step 5: Verify the manuscript type carries `user_id`**

The commit needs `manuscript.user_id`. Confirm `DraftWithManuscript`'s manuscript type includes it:

Run: `grep -n "DraftWithManuscript" -A 12 lib/types/index.ts`

If `user_id` is absent from the manuscript shape, add it as `user_id: string` — the query at `lib/ai/pipeline.ts:125` selects `manuscripts(*)`, so the value is present at runtime and only the type needs widening.

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add lib/ai/pipeline.ts lib/types/index.ts
git commit -m "Commit the review credit on completion, release it on failure"
```

---

## Task 10: Release credits for reaped reviews

Only the **main** lifecycle holds a credit. The three sub-pipeline lifecycles (`adversarial_status`, `journal_match_status`, `reporting_check_status`) never reserved one, so reaping them must not release anything.

**Files:**
- Modify: `app/api/cron/reap-reviews/route.ts:118-121`
- Test: `tests/reapReviews.test.ts`

- [ ] **Step 1: Add the import**

In `app/api/cron/reap-reviews/route.ts`:

```ts
import { releaseReviewCredit } from '@/lib/plan/ledger'
```

- [ ] **Step 2: Release when the main lifecycle is claimed**

Inside the `if (claimed && claimed.length > 0)` block (line 118), add the release before the existing push:

```ts
      if (claimed && claimed.length > 0) {
        // Only the main lifecycle ever held a review credit; the three
        // sub-pipelines run on an already-charged session.
        if (lifecycle.column === 'status') {
          await releaseReviewCredit(row.id)
        }
        console.warn(`[reap-reviews] ${row.id}: ${lifecycle.column} '${lifecycle.from}' -> failed`)
        reaped.push({ sessionId: row.id, column: lifecycle.column, from: lifecycle.from })
      }
```

- [ ] **Step 3: Run the existing reaper tests**

Run: `npx vitest run tests/reapReviews.test.ts`
Expected: PASS. If the suite fails because `@/lib/plan/ledger` pulls in `lib/supabase/admin` (which imports `server-only`), add this mock alongside the file's existing mocks:

```ts
vi.mock('@/lib/plan/ledger', () => ({ releaseReviewCredit: vi.fn() }))
```

- [ ] **Step 4: Build and commit**

```bash
npm run build
git add app/api/cron/reap-reviews/route.ts tests/reapReviews.test.ts
git commit -m "Release the review credit when a stuck review is reaped"
```

---

## Task 11: Reserve a fresh credit on retry

`/api/review/retry` reuses the **same session id**. The previous attempt's row is already `released`, so a new `reserved` row cannot double-count and the retry stays visible in the audit trail.

**Files:**
- Modify: `app/api/review/retry/route.ts:36-48`

- [ ] **Step 1: Add the reservation**

Add the import:

```ts
import { insertReservation } from '@/lib/plan/ledger'
```

Then, after the atomic `failed -> queued` claim succeeds — that is, immediately after the `if (!claimed || claimed.length === 0)` guard (line 73) and before the `scores`/`annotations` cleanup — insert:

```ts
  // Reserve a fresh credit for this attempt. The previous attempt's row was
  // released when it failed, so this does not double-charge; recording a new
  // row rather than reviving the old one keeps the retry in the audit trail.
  await insertReservation(user.id, planLimit.windowStart, sessionId)
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: succeeds — `planLimit` is already in scope from the existing `checkReviewLimit` call at line 38.

- [ ] **Step 3: Commit**

```bash
git add app/api/review/retry/route.ts
git commit -m "Reserve a fresh review credit on retry"
```

---

## Task 12: Surface exhaustion in the usage API and card

**Files:**
- Modify: `app/api/billing/usage/route.ts:15-47`
- Modify: `components/dashboard/UsageCard.tsx`

- [ ] **Step 1: Report `exhausted` and `resets`**

In `app/api/billing/usage/route.ts`, add `quota_resets` to the plans selection on line 20:

```ts
        .select('plan_id, plans(adversarial_access, journal_matching, pdf_reports, api_access, max_api_keys, quota_resets)')
```

Widen the `plan` cast to include it:

```ts
    const plan = sub?.plans as unknown as {
      adversarial_access: boolean
      journal_matching: boolean
      pdf_reports: boolean
      api_access: boolean
      max_api_keys: number | null
      quota_resets: boolean | null
    } | null
```

And extend the JSON response — add these two fields after `reviewsThisMonth`:

```ts
      // A plans row predating migration 020 has no flag; those all reset.
      resets: plan?.quota_resets !== false,
      // "Exhausted" means no further reviews are possible right now. On a
      // non-resetting plan (Free) that means upgrade; on a paid plan it means
      // wait for the next billing month.
      exhausted:
        Number.isFinite(reviewsThisMonth.limit) && reviewsThisMonth.used >= reviewsThisMonth.limit,
```

- [ ] **Step 2: Render the upgrade state**

In `components/dashboard/UsageCard.tsx`, extend the interface:

```ts
interface Usage {
  plan: string
  manuscripts: { used: number; limit: number | null }
  reviewsThisMonth: { used: number; limit: number | null }
  resets: boolean
  exhausted: boolean
}
```

Replace the card's return block (lines 50-58) with:

```tsx
  const oneTimeExhausted = usage.exhausted && !usage.resets

  return (
    <Card className="mb-6 p-5">
      <div className="mb-3 text-sm font-medium">
        {usage.resets ? 'Usage this month' : 'Usage'}
      </div>
      <div className="space-y-4">
        <Bar label="Manuscripts" used={usage.manuscripts.used} limit={usage.manuscripts.limit} />
        <Bar label="Reviews" used={usage.reviewsThisMonth.used} limit={usage.reviewsThisMonth.limit} />
      </div>
      {oneTimeExhausted && (
        <div className="mt-4 rounded-md border border-pr-teal/30 bg-pr-teal/5 p-3">
          <p className="text-sm font-medium text-pr-navy">You&apos;ve used your free reviews</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The free allowance is one-time and doesn&apos;t renew. Your account stays active and
            all your existing reviews remain available.
          </p>
          <Link
            href="/billing"
            className="mt-2 inline-block text-xs font-medium text-pr-teal hover:underline"
          >
            Upgrade to continue →
          </Link>
        </div>
      )}
    </Card>
  )
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
npm run build
git add app/api/billing/usage/route.ts components/dashboard/UsageCard.tsx
git commit -m "Surface one-time-plan exhaustion in usage API and card"
```

---

## Task 13: Re-Review button and picker page

`GET /api/manuscripts` already returns `drafts(id, version_number, review_sessions(id, status, overall_score, verdict))`, so no new endpoint is needed. The selection logic goes in a pure, tested helper.

**Files:**
- Create: `lib/manuscripts/reviewed.ts`
- Test: `tests/manuscriptsReviewed.test.ts`
- Create: `app/(dashboard)/manuscripts/re-review/page.tsx`
- Modify: `app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/manuscriptsReviewed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withCompletedReview, type ReviewableManuscript } from '@/lib/manuscripts/reviewed'

const m = (id: string, sessions: { status: string; overall_score?: number | null }[]): ReviewableManuscript => ({
  id,
  title: `Manuscript ${id}`,
  drafts: [{ id: `d-${id}`, version_number: 1, review_sessions: sessions.map((s, i) => ({
    id: `s-${id}-${i}`, status: s.status, overall_score: s.overall_score ?? null, completed_at: null,
  })) }],
})

describe('withCompletedReview', () => {
  it('keeps only manuscripts with at least one complete session', () => {
    const result = withCompletedReview([
      m('a', [{ status: 'complete', overall_score: 7 }]),
      m('b', [{ status: 'failed' }]),
      m('c', [{ status: 'reviewing' }]),
      m('d', []),
    ])
    expect(result.map((r) => r.id)).toEqual(['a'])
  })

  it('surfaces the latest completed score across all drafts', () => {
    const manuscript: ReviewableManuscript = {
      id: 'x',
      title: 'X',
      drafts: [
        { id: 'd1', version_number: 1, review_sessions: [
          { id: 's1', status: 'complete', overall_score: 5, completed_at: '2026-01-01T00:00:00Z' },
        ] },
        { id: 'd2', version_number: 2, review_sessions: [
          { id: 's2', status: 'complete', overall_score: 8, completed_at: '2026-02-01T00:00:00Z' },
        ] },
      ],
    }
    const [only] = withCompletedReview([manuscript])
    expect(only.lastScore).toBe(8)
    expect(only.reviewCount).toBe(2)
  })

  it('tolerates a manuscript with no drafts array at all', () => {
    const result = withCompletedReview([{ id: 'z', title: 'Z' } as ReviewableManuscript])
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/manuscriptsReviewed.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/manuscripts/reviewed'".

- [ ] **Step 3: Implement the helper**

Create `lib/manuscripts/reviewed.ts`:

```ts
/**
 * Which manuscripts can be re-reviewed, and how they last scored.
 *
 * Pure so it can be tested without a network round trip; the shape matches what
 * `GET /api/manuscripts` already returns, so the Re-Review page needs no new
 * endpoint.
 */

export interface ReviewableSession {
  id: string
  status: string
  overall_score: number | null
  completed_at: string | null
}

export interface ReviewableManuscript {
  id: string
  title: string
  drafts?: { id: string; version_number: number; review_sessions?: ReviewableSession[] }[]
}

export interface ReReviewCandidate {
  id: string
  title: string
  reviewCount: number
  lastScore: number | null
  lastReviewedAt: string | null
}

export function withCompletedReview(manuscripts: ReviewableManuscript[]): ReReviewCandidate[] {
  const candidates: ReReviewCandidate[] = []

  for (const manuscript of manuscripts) {
    const completed = (manuscript.drafts ?? [])
      .flatMap((d) => d.review_sessions ?? [])
      .filter((s) => s.status === 'complete')

    if (completed.length === 0) continue

    // Null completed_at sorts oldest so a session that completed without the
    // timestamp never masks one that has it.
    const latest = completed.reduce((newest, s) =>
      (s.completed_at ?? '') > (newest.completed_at ?? '') ? s : newest
    )

    candidates.push({
      id: manuscript.id,
      title: manuscript.title,
      reviewCount: completed.length,
      lastScore: latest.overall_score,
      lastReviewedAt: latest.completed_at,
    })
  }

  return candidates
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/manuscriptsReviewed.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Build the picker page**

Create `app/(dashboard)/manuscripts/re-review/page.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { withCompletedReview, type ReReviewCandidate } from '@/lib/manuscripts/reviewed'

export default function ReReviewPage() {
  const router = useRouter()
  const [candidates, setCandidates] = useState<ReReviewCandidate[] | null>(null)

  useEffect(() => {
    fetch('/api/manuscripts?status=active&sort=updated_at')
      .then((r) => r.json())
      .then((d) => setCandidates(withCompletedReview(d.manuscripts ?? [])))
      .catch(() => setCandidates([]))
  }, [])

  return (
    <div>
      <Link
        href="/dashboard"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to dashboard
      </Link>

      <h1 className="mb-2 text-2xl font-semibold">Re-review a manuscript</h1>
      <p className="mb-5 text-muted-foreground">
        Pick a manuscript you&apos;ve already had reviewed. You&apos;ll upload the revised version,
        and the new review is compared against the previous one.
      </p>

      {candidates === null ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : candidates.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No completed reviews yet.{' '}
          <Link href="/manuscripts/new" className="text-pr-teal hover:underline">
            Start your first review
          </Link>
          .
        </div>
      ) : (
        <div className="space-y-2.5">
          {candidates.map((c) => (
            <Card key={c.id} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {c.reviewCount} review{c.reviewCount === 1 ? '' : 's'}
                  {c.lastScore !== null && ` · last score ${c.lastScore}/10`}
                  {c.lastReviewedAt &&
                    ` · ${new Date(c.lastReviewedAt).toLocaleDateString()}`}
                </p>
              </div>
              <Button size="sm" onClick={() => router.push(`/manuscripts/${c.id}/upload`)}>
                <RefreshCw className="h-3.5 w-3.5" /> Re-review
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Build the dashboard action buttons**

The dashboard page is a server component, but the buttons need the client-side
usage response to know whether to offer an upgrade instead. Extract them into
their own client component rather than converting the whole page.

Create `components/dashboard/DashboardActions.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

// The API's 403 is the authoritative gate; this only saves the user a wasted
// click. It therefore renders the normal buttons whenever usage is unknown.
export function DashboardActions() {
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    fetch('/api/billing/usage')
      .then((r) => r.json())
      .then((d) => setBlocked(Boolean(d?.exhausted) && d?.resets === false))
      .catch(() => setBlocked(false))
  }, [])

  if (blocked) {
    return (
      <div className="flex flex-wrap items-center gap-2.5">
        <Link href="/billing"><Button>Upgrade to continue</Button></Link>
        <Link href="/manuscripts">
          <Button variant="outline">View past reviews</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2.5">
      <Link href="/manuscripts/new"><Button>New review</Button></Link>
      <Link href="/manuscripts/re-review">
        <Button variant="outline">Re-Review</Button>
      </Link>
    </div>
  )
}
```

- [ ] **Step 7: Wire it into the dashboard**

Replace `app/(dashboard)/dashboard/page.tsx` entirely with:

```tsx
import { UsageCard } from '@/components/dashboard/UsageCard'
import { DashboardActions } from '@/components/dashboard/DashboardActions'

export default function DashboardPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Welcome to ScholarLens</h1>
      <p className="mb-4 text-muted-foreground">Upload a manuscript to get an AI peer review.</p>
      <DashboardActions />
      <div className="mt-6 max-w-sm">
        <UsageCard />
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Verify the build**

Run: `npm run build`
Expected: succeeds, and `/manuscripts/re-review` appears in the route list.

- [ ] **Step 9: Commit**

```bash
git add lib/manuscripts/reviewed.ts tests/manuscriptsReviewed.test.ts app/\(dashboard\)/manuscripts/re-review/page.tsx app/\(dashboard\)/dashboard/page.tsx components/dashboard/DashboardActions.tsx
git commit -m "Add Re-Review button and manuscript picker page"
```

---

## Task 14: Backfill the ledger

Without this, every existing user gets a full fresh allowance the moment the ledger goes live.

**Files:**
- Create: `scripts/backfill-usage-ledger.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/backfill-usage-ledger.mjs`:

```js
// One-time backfill of usage_events from surviving review sessions.
//
// Without this, every existing user starts at zero usage the moment the ledger
// goes live. Reviews whose manuscripts were already deleted are unrecoverable
// and go uncounted — a deliberate one-time amnesty.
//
// Idempotent: re-running inserts nothing new. Safe to run repeatedly.
//
// Reads .env.local explicitly — OS-level environment variables shadow the file
// on this machine and have previously pointed scripts at the wrong project.
//
// Usage:  node scripts/backfill-usage-ledger.mjs [--apply]
//         (defaults to a dry run; --apply performs the writes)
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

const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
console.log(`project: ${URL_BASE}`)
console.log(APPLY ? 'mode: APPLY (writing)' : 'mode: DRY RUN (use --apply to write)')

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

// Every completed session, with the owner and manuscript reachable through the
// join. Sessions whose manuscript was deleted are already gone from this set.
const sessions = await rest(
  'review_sessions?status=eq.complete&select=id,created_at,completed_at,drafts(manuscript_id,manuscripts(id,user_id))'
)
console.log(`completed sessions found: ${sessions.length}`)

const existing = await rest('usage_events?select=review_session_id,manuscript_id,kind')
const seenSessions = new Set(existing.filter((e) => e.review_session_id).map((e) => e.review_session_id))
const seenSlots = new Set(
  existing.filter((e) => e.kind === 'manuscript_slot' && e.manuscript_id).map((e) => e.manuscript_id)
)

// Window start per user. The gates recompute windows live, so a backfilled row
// only has to land at or after the user's current window to count. Using the
// session's own timestamp keeps historical rows in the window they belong to.
const reviewRows = []
const slotRows = []

for (const s of sessions) {
  const manuscript = s.drafts?.manuscripts
  if (!manuscript) continue // manuscript already deleted — amnesty
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

console.log(`review credits to insert: ${reviewRows.length}`)
console.log(`manuscript slots to insert: ${slotRows.length}`)

if (!APPLY) {
  console.log('dry run complete — nothing written')
  process.exit(0)
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

console.log('backfill complete')
```

- [ ] **Step 2: Dry run**

Run: `node scripts/backfill-usage-ledger.mjs`
Expected: prints the project URL, `mode: DRY RUN`, the session count, and the two insert counts. Writes nothing.

- [ ] **Step 3: Apply**

Run: `node scripts/backfill-usage-ledger.mjs --apply`
Expected: `backfill complete`.

- [ ] **Step 4: Verify idempotency**

Run: `node scripts/backfill-usage-ledger.mjs`
Expected: `review credits to insert: 0` and `manuscript slots to insert: 0`.

- [ ] **Step 5: Spot-check the result in SQL**

```sql
select kind, state, count(*) from public.usage_events group by kind, state order by kind, state;
```

Expected: `manuscript_slot/consumed` and `review/consumed` counts matching what the script reported.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-usage-ledger.mjs
git commit -m "Add one-time usage ledger backfill script"
```

---

## Task 15: Password reset — the recovery path

This is what lets `hakimkassama@gmail.com` and `zkassama@googlemail.com` sign in. Setting a password on a Google-only account **creates the email identity** that is currently missing.

**Files:**
- Create: `app/(auth)/forgot-password/page.tsx`
- Create: `app/(auth)/reset-password/page.tsx`
- Modify: `middleware.ts:31`

- [ ] **Step 1: Build the request page**

Create `app/(auth)/forgot-password/page.tsx`:

```tsx
'use client'
import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Logo } from '@/components/layout/Logo'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError(null)
    const supabase = createClient()
    // The recovery link lands on /auth/callback, which exchanges the code for a
    // session and forwards to /reset-password with that session in place.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })
    setLoading(false)
    if (error) { setError(error.message); return }
    // Always report success: whether an address is registered is not something
    // this page should reveal.
    setSent(true)
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Logo size={32} />
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-4 text-xl font-semibold text-pr-navy">Reset your password</h1>
        {sent ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              If an account exists for <span className="font-medium">{email}</span>, we&apos;ve sent
              a link to set a new password. Check your inbox and your spam folder.
            </p>
            <Link href="/login" className="inline-block text-sm text-pr-teal underline">
              Back to log in
            </Link>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              Enter your email and we&apos;ll send you a link to set a new password. This also works
              if you originally signed up with Google and have never had a password.
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input className="w-full rounded border p-2" type="email" placeholder="Email"
                value={email} onChange={e => setEmail(e.target.value)} required />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
            <p className="mt-4 text-sm text-muted-foreground">
              Remembered it? <Link href="/login" className="underline">Log in</Link>
            </p>
          </>
        )}
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: Build the set-password page**

Create `app/(auth)/reset-password/page.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Logo } from '@/components/layout/Logo'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [ready, setReady] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // /auth/callback has already exchanged the recovery code for a session by the
  // time we get here. Without one there is nothing to update.
  useEffect(() => {
    createClient().auth.getSession().then(({ data }) => setReady(!!data.session))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true); setError(null)
    // On an account that only had a Google identity, this creates the email
    // identity — which is what makes password login work for the first time.
    const { error } = await createClient().auth.updateUser({ password })
    setLoading(false)
    if (error) { setError(error.message); return }
    router.replace('/dashboard')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Logo size={32} />
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-4 text-xl font-semibold text-pr-navy">Set a new password</h1>
        {ready === false ? (
          <div className="space-y-3">
            <p className="text-sm text-red-600">
              This reset link is invalid or has expired.
            </p>
            <Link href="/forgot-password" className="inline-block text-sm text-pr-teal underline">
              Request a new one
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input className="w-full rounded border p-2" type="password" placeholder="New password"
              value={password} onChange={e => setPassword(e.target.value)} required />
            <input className="w-full rounded border p-2" type="password" placeholder="Confirm new password"
              value={confirm} onChange={e => setConfirm(e.target.value)} required />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || ready === null}>
              {loading ? 'Saving…' : 'Set password'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Make both pages public**

In `middleware.ts` line 31, extend the public prefixes:

```ts
  const publicPrefixes = ['/login', '/signup', '/forgot-password', '/reset-password', '/api', '/auth', '/legal']
```

Leave `isAuthPage` unchanged — it must keep matching only `/login` and `/signup`, because `/reset-password` is reached **while signed in** via the recovery session, and adding it there would bounce the user to `/dashboard` before they could set a password.

- [ ] **Step 4: Configure the Supabase redirect allow-list**

In the Supabase dashboard → Authentication → URL Configuration, confirm the production and localhost `/auth/callback` URLs are in **Redirect URLs**. Without this the reset link fails with `otp_expired`.

Expected entries: `https://<production-domain>/auth/callback` and `http://localhost:3000/auth/callback`.

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: succeeds, with `/forgot-password` and `/reset-password` in the route list.

- [ ] **Step 6: Verify the fix end to end against a real affected account**

Run: `npm run dev`, then from a browser:
1. Go to `/forgot-password` and submit `hakimkassama@gmail.com`.
2. Open the emailed link.
3. Set a password on `/reset-password`.
4. Confirm the redirect to `/dashboard` succeeds.
5. Sign out, then log in at `/login` with that email and the new password.

Expected: login succeeds. Then confirm the identity now exists:

Run: `node scripts/diag-auth-identities.mjs`
Expected: `hakimkassama@gmail.com  identities=[google,email]` — the `email` identity is new.

- [ ] **Step 7: Commit**

```bash
git add app/\(auth\)/forgot-password/page.tsx app/\(auth\)/reset-password/page.tsx middleware.ts
git commit -m "Add password reset flow; fixes login for Google-only accounts"
```

---

## Task 16: Stop signup silently succeeding for existing accounts

The root cause of the reported bug. `signUp` on an existing address returns an obfuscated success with an **empty `identities` array**, sets no password, and sends no email — and the current code treats that as a completed registration.

**Files:**
- Modify: `app/(auth)/signup/page.tsx:19-31, 46-49`

- [ ] **Step 1: Rewrite the submit handler**

In `app/(auth)/signup/page.tsx`, replace `handleSignup` (lines 19-31) and add the two new state values:

```tsx
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [checkEmail, setCheckEmail] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError(null); setNotice(null)
    const supabase = createClient()
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    setLoading(false)
    if (error) { setError(error.message); return }

    // Supabase does not error when the address already exists — it returns an
    // obfuscated success with an empty identities array, sets no password, and
    // sends no email. Treating that as a real signup is what left users unable
    // to log in with a password they believed they had just chosen.
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      setNotice(
        'An account already exists for this email. Log in below, continue with Google, or reset your password if you have forgotten it.'
      )
      return
    }

    // Email confirmation is on, so there is no session yet. Pushing to
    // /dashboard here just gets bounced back to /login by the middleware.
    if (!data.session) { setCheckEmail(true); return }

    router.push('/dashboard')
    router.refresh()
  }
```

- [ ] **Step 2: Render the two new states**

Replace the form block (lines 38-49) with:

```tsx
        {checkEmail ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Check your email — we&apos;ve sent a confirmation link to{' '}
              <span className="font-medium">{email}</span>. Once you&apos;ve confirmed, you can log
              in with your email and password.
            </p>
            <Link href="/login" className="inline-block text-sm text-pr-teal underline">
              Go to log in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSignup} className="space-y-3">
            <input className="w-full rounded border p-2" placeholder="Full name"
              value={fullName} onChange={e => setFullName(e.target.value)} />
            <input className="w-full rounded border p-2" type="email" placeholder="Email"
              value={email} onChange={e => setEmail(e.target.value)} required />
            <input className="w-full rounded border p-2" type="password" placeholder="Password"
              value={password} onChange={e => setPassword(e.target.value)} required />
            {notice && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800">
                {notice}{' '}
                <Link href="/forgot-password" className="font-medium underline">Reset password</Link>
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Creating…' : 'Sign up'}
            </Button>
          </form>
        )}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Verify manually**

Run `npm run dev`, then:
1. At `/signup`, register a brand-new address. Expected: the "Check your email" panel, **not** a redirect to `/dashboard`.
2. Confirm via the emailed link, then log in with the password. Expected: success.
3. At `/signup`, submit `emm247@gmail.com` (an existing account) with any password. Expected: the amber "An account already exists" notice, and no navigation.

- [ ] **Step 5: Commit**

```bash
git add app/\(auth\)/signup/page.tsx
git commit -m "Signup: detect existing accounts instead of faking success"
```

---

## Task 17: Make the login error actionable

**Files:**
- Modify: `app/(auth)/login/page.tsx:18-29, 41`

- [ ] **Step 1: Map the opaque error**

In `app/(auth)/login/page.tsx`, replace `handleLogin` (lines 18-29) with:

```tsx
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) {
      // "Invalid login credentials" is also what Supabase returns when the
      // account has no password at all — the case for anyone who signed up
      // with Google. Naming both recovery routes turns a dead end into a fix.
      setError(
        error.message === 'Invalid login credentials'
          ? 'We couldn’t sign you in. If you signed up with Google, use "Continue with Google" below — or reset your password to set one.'
          : error.message === 'Email not confirmed'
            ? 'Please confirm your email first — check your inbox for the link we sent.'
            : error.message
      )
      return
    }
    // replace (not push) so the login page is not left in history, and refresh
    // so the middleware re-reads the freshly-set session cookie.
    router.replace('/dashboard')
    router.refresh()
  }
```

- [ ] **Step 2: Add the forgot-password link**

Replace the error line (line 41) and the block that follows the submit button so the card reads:

```tsx
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Logging in…' : 'Log in'}
          </Button>
          <div className="text-right">
            <Link href="/forgot-password" className="text-xs text-muted-foreground underline hover:text-foreground">
              Forgot password?
            </Link>
          </div>
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Verify manually**

Run `npm run dev`, go to `/login`, and attempt to log in with `zkassama@googlemail.com` and any password.
Expected: the message naming Google sign-in and password reset — **not** the raw "Invalid login credentials".

- [ ] **Step 5: Commit**

```bash
git add app/\(auth\)/login/page.tsx
git commit -m "Login: explain the credential error and link to recovery"
```

---

## Task 18: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: all suites pass. Pay particular attention to `planGates`, `planLedger`, `planPeriod`, `manuscriptsReviewed`, and `reapReviews`.

- [ ] **Step 2: Run the build gate**

Run: `npm run build`
Expected: succeeds with no type errors.

- [ ] **Step 3: Verify the core bug is actually fixed, end to end**

Against a dev server with a **Free** test account:

1. Note the usage card: `Reviews 0 / 2`.
2. Upload a manuscript and confirm the card still reads `Reviews 0 / 2` — **nothing is charged at upload**.
3. Delete that manuscript. Confirm manuscript usage returns to 0 — an un-reviewed manuscript is free.
4. Upload another and run a review to completion. Confirm the card reads `Reviews 1 / 2` and `Manuscripts 1 / 3`.
5. **Delete the reviewed manuscript.** Reload the dashboard.
6. Expected: the card **still** reads `Reviews 1 / 2` and `Manuscripts 1 / 3`. This is the bug fixed.
7. Run a second review to completion, then attempt a third.
8. Expected: 403, "Monthly review limit reached (2/2 on the Free plan)", and the usage card shows the one-time "You've used your free reviews / Upgrade to continue" panel rather than a monthly message.
9. Confirm the account still logs in, the dashboard loads, and the completed reviews are still readable.

- [ ] **Step 4: Confirm the ledger survived the deletion in SQL**

```sql
select kind, state, manuscript_id, review_session_id, window_start
  from public.usage_events
 where user_id = '<test user id>'
 order by created_at;
```

Expected: the review and slot rows for the deleted manuscript are still present, still `consumed`, with their now-dangling `manuscript_id` intact.

- [ ] **Step 5: Commit any fixes and push**

```bash
npm run build
git status
git push -u origin HEAD
```

Open a PR. Per project convention, do not merge without an explicit per-PR instruction.

---

## Deployment order

Migrations first, then code, then the backfill:

1. Apply `019_usage_events.sql` and `020_plan_quota_resets.sql` (Tasks 1-2). Both are additive, so the currently-deployed code keeps working.
2. Merge and deploy the application changes (Tasks 3-13, 15-17).
3. Run `node scripts/backfill-usage-ledger.mjs --apply` (Task 14) **immediately after** the deploy, so the window between the ledger going live and being populated is short. Anyone who starts a review inside that window gets one extra credit — acceptable, and cheaper than taking the app down.

## Rollback

The change is additive to the schema. To revert, roll the application back to the previous release; `usage_events` and `plans.quota_resets` can stay in place and are simply ignored by the older code. No data is destroyed by a rollback.
