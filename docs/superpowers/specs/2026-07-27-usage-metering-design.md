# Usage metering & limits — Design

**Date:** 2026-07-27
**Status:** Approved, ready for implementation plan

## Problem

The `plans` table advertises manuscript counts, monthly review counts, and three
feature flags (`adversarial_access`, `journal_matching`, `pdf_reports`) per plan,
and the marketing/billing pages present these as real differentiators. In practice:

- `max_manuscripts` is **never enforced** anywhere in the app.
- `max_reviews_per_month` has an enforcement helper (`checkReviewLimit` in
  `lib/plan/gates.ts`) but it is **dead code** — never called from any route.
- The three feature flags are **never checked** by the endpoints they're supposed
  to gate (`/api/review/adversarial/start`, `/api/review/journals/start`,
  `/api/pdf/[sessionId]`).
- Only API keys (`max_api_keys`, `api_access`, `allowed_scopes`, enforced in
  `app/api/keys/route.ts`) actually work today.
- Separately, the live `plans` data itself disagrees with the marketing copy on
  who gets what (see below) — this must be fixed before enforcement goes live, or
  turning on gates would either do nothing (flag already `true` for everyone) or
  break a promise already made in the pricing copy.
- There is also no user-facing way to see "used X of Y" for anything, so even
  where limits exist conceptually, a user has no way to know they're close to one
  short of hitting a wall.

## Goal

Make the plan limits and feature flags actually mean something: enforce them at
the point of use, fix the data so enforcement matches what customers were told,
and surface "used / remaining" to the user with a clear upgrade path when they're
at or near a cap.

## Decisions locked during brainstorming

1. **"Buy more" is upgrade-only for v1.** Hitting a cap shows an upgrade nudge to
   `/billing`. No metered top-up packs, no new Stripe products — out of scope
   (YAGNI). The usage-tracking data model doesn't need special accommodation for
   this later; a future top-up feature would just add to the "used" side of the
   same counts.
2. **Enforcement scope:** manuscripts, reviews/month, and all three feature flags
   get real enforcement in this pass. API keys are already enforced — just folded
   into the same usage-display UI for a consistent picture.
3. **Usage is shown in two places:** a compact widget on `/dashboard`, and the
   same numbers next to the plan cards on `/billing`.
4. **Data-integrity fixes (resolve the plan-vs-copy mismatches), all in the
   "match the marketing copy, fix the DB" direction:**
   - `adversarial_access`: DB currently `true` for every plan; copy implies
     Pro-only. **Fix:** `false` for Free & Starter, stays `true` for Pro/Team.
   - `journal_matching`: DB already correct (`false` Free/Starter, `true`
     Pro/Team) — the mismatch was Starter's marketing copy promising it anyway.
     **Fix:** remove the "Journal matching" bullet from Starter's copy.
   - `pdf_reports`: DB currently `true` for every plan; copy implies Starter+.
     **Fix:** `false` for Free, stays `true` for Starter/Pro/Team.
5. **Manuscript cap counts non-archived manuscripts.** Archiving a manuscript
   frees a slot — matches the existing archive feature's purpose.

## Architecture

### 1. Data fix — one-time script

`scripts/fix-plan-feature-flags.mjs` (one-off, run once against the live DB via
the service-role key, mirroring `scripts/rebrand-stripe-products.mjs`'s
`.env.local` loading pattern):

```js
UPDATE plans SET adversarial_access = false WHERE id IN ('free', 'starter');
UPDATE plans SET pdf_reports = false WHERE id = 'free';
```

Copy fixes: remove `'Journal matching'` from `PLAN_META.starter.extraFeatures`
in `app/(dashboard)/billing/page.tsx` and from `EXTRA_FEATURES.starter` in
`components/marketing/PricingSection.tsx`.

### 2. Gate helpers — `lib/plan/gates.ts` (rewritten)

All three check functions:
- Take a `userId`, use `createAdminClient()` internally (bypasses RLS, filters
  explicitly by `user_id`) so they work identically whether the caller
  authenticated via cookie session or API key — no more of the manual
  draft-id-resolution dance `review/start` currently does for its own rate limits.
- Bypass entirely (`{ allowed: true }`) for `super_admin`, matching the existing
  precedent in `app/api/keys/route.ts`.
- Treat a `null` limit column as unlimited (existing convention).

```ts
checkManuscriptLimit(userId): Promise<{ allowed: boolean; used: number; limit: number }>
// counts manuscripts where archived = false

checkReviewLimit(userId): Promise<{ allowed: boolean; used: number; limit: number }>
// counts review_sessions created this calendar month, scoped via manuscripts→drafts
// owned by userId (same join shape as today, just via admin client + explicit user_id)

checkFeatureGate(userId, feature: 'adversarial_access' | 'journal_matching' | 'pdf_reports')
  : Promise<{ allowed: boolean; plan: string }>
// looks up the user's plan row, returns isFeatureAllowed(plan, feature)
```

`isFeatureAllowed` (pure, already tested) is unchanged and reused inside
`checkFeatureGate`. `checkPlanGate` (the old, unused wrapper) is removed —
`checkFeatureGate` replaces it with the super-admin bypass folded in.

### 3. Wire gates into endpoints

| Route | Gate | On block |
|---|---|---|
| `POST /api/manuscripts` | `checkManuscriptLimit` | 403 `{ error: "Manuscript limit reached (1/1 on the Free plan)", upgradeUrl: '/billing' }` |
| `POST /api/review/start` | `checkReviewLimit` (in addition to the existing unrelated hourly abuse rate-limit) | 403 with the same shape |
| `POST /api/review/adversarial/start` | `checkFeatureGate(..., 'adversarial_access')` | 403 `{ error: "Adversarial review requires a Pro plan or above", upgradeUrl: '/billing' }` |
| `POST /api/review/journals/start` | `checkFeatureGate(..., 'journal_matching')` | 403, same shape, "Journal matching requires a Pro plan or above" |
| `GET /api/pdf/[sessionId]` | `checkFeatureGate(..., 'pdf_reports')` | 403, same shape, "PDF reports require a Starter plan or above" |

Message wording follows the existing precedent in `app/api/keys/route.ts`
("API keys require a Starter plan or above").

### 4. New endpoint — `GET /api/billing/usage`

Single source of truth for both UI surfaces. Auth via cookie session only (no
API-key path needed — this is a UI-facing endpoint).

```json
{
  "plan": "starter",
  "manuscripts": { "used": 1, "limit": 2 },
  "reviewsThisMonth": { "used": 3, "limit": 4 },
  "features": { "adversarial_access": false, "journal_matching": false, "pdf_reports": true },
  "apiKeys": { "used": 1, "limit": 2 }
}
```

### 5. UI

- **`components/dashboard/UsageCard.tsx`** — new, rendered on `/dashboard`.
  Progress bars for manuscripts and reviews-this-month; bar turns amber past 80%
  used, and a "You're at your limit — Upgrade" link appears once at 100%.
- **`/billing`** — add the same two numbers (manuscripts, reviews) as a small
  line under the current-plan summary text near the top of the page (not
  per-card, since usage is a single number regardless of which plan card you're
  looking at).

### 6. Testing

- Unit: `checkManuscriptLimit`, `checkReviewLimit`, `checkFeatureGate` — allowed
  / at-cap / over-cap / null-limit-is-unlimited / super-admin-bypass cases,
  following the existing `tests/planGates.test.ts` and `tests/rateLimit.test.ts`
  patterns (mocking the Supabase admin client).
- `npm run build` and `npm test` must pass (house rule).
- Manual: exhaust each cap as a Free-plan test user and confirm the 403 +
  upgrade copy, then confirm the dashboard/billing usage numbers move.

## Out of scope (YAGNI)

- Metered top-up packs / one-time credit purchases.
- Team plan usage pooling across multiple team members (Team is single-seat
  today per `team_members` semantics elsewhere in the schema — a separate
  concern from this feature).
- Historical usage charts / trends (that's the separate per-user statistics
  dashboard feature, not this one).
- Soft warning emails ("you're at 80% of your quota") — the amber progress bar
  is the only proactive signal for v1.
