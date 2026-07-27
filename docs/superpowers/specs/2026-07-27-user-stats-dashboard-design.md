# Per-user statistics dashboard — Design

**Date:** 2026-07-27
**Status:** Approved, ready to build

## Problem

Users have no visibility into their own review activity — total manuscripts,
review outcomes, or how they score across dimensions. Admins have the same gap
for support/oversight when looking at a specific user.

## Decisions locked during brainstorming

1. **Audience: both.** The same stats surface for a user's own profile and for
   an admin looking at any user.
2. **Scope:** headline tiles (total manuscripts, total reviews, average overall
   score, average turnaround time) + a verdict breakdown chart + a
   dimension-averages radar chart. No time-trend line chart (deferred — YAGNI
   for v1).
3. **Charts, per the dataviz skill's procedure:**
   - Verdict breakdown (accept / minor_revision / major_revision / reject) is a
     single-series horizontal bar chart using the skill's pre-validated, fixed
     **status palette** (`good` `#0ca30c` / `warning` `#fab219` / `serious`
     `#ec835a` / `critical` `#d03b3b`), mapped 1:1 to the four verdicts. Direct
     category + count labels on each bar — no legend needed for one series.
     Light-mode warning/serious sub-3:1 contrast is mitigated by those direct
     labels (the palette's documented relief rule).
   - Dimension averages reuse the existing `components/review/ScoreRadar.tsx`
     unchanged, fed a synthesized `Score[]` of per-dimension averages across all
     the subject's completed reviews.

## Architecture

### 1. Aggregation — `lib/stats/userStats.ts`

```ts
getUserStats(userId): Promise<{
  manuscripts: number
  reviews: number
  avgScore: number | null          // null = no completed reviews yet
  avgTurnaroundHours: number | null
  verdicts: Record<'accept'|'minor_revision'|'major_revision'|'reject', number>
  dimensionAverages: { dimension: ScoreDimension; score: number }[]
}>
```

Uses `createAdminClient()` + explicit `user_id` filtering (same pattern as
`lib/plan/gates.ts`), so it works for both the self endpoint and the admin
endpoint without RLS concerns:
- `manuscripts`: count of all manuscripts for the user (archived + active —
  this is a lifetime activity count, unlike the archived-excluding cap in
  `checkManuscriptLimit`).
- `reviews`: count of `review_sessions` with `status = 'complete'`, scoped via
  manuscripts → drafts (same join shape as `checkReviewLimit`).
- `avgScore`: average of `overall_score` across those completed sessions.
- `avgTurnaroundHours`: average of `(completed_at - created_at)` in hours,
  across sessions that have both timestamps.
- `verdicts`: count grouped by `verdict` across completed sessions.
- `dimensionAverages`: average `score` per `dimension` from the `scores` table,
  joined via the same completed session ids.
- All fields are zero/null-safe: a user with zero completed reviews gets
  `reviews: 0, avgScore: null, avgTurnaroundHours: null, verdicts: {all 0},
  dimensionAverages: []`.

### 2. Endpoints

- `GET /api/stats/me` — cookie auth, always the caller's own stats.
- `GET /api/admin/users/[userId]/stats` — gated by the existing `users.view`
  permission (`requirePermission`, same as the admin users list endpoint).

Both call `getUserStats` and return the same JSON shape.

### 3. UI

- **`components/stats/UserStatsPanel.tsx`** — `{ userId? }`. If `userId` is
  omitted, fetches `/api/stats/me`; otherwise fetches
  `/api/admin/users/${userId}/stats`. Renders:
  - Four stat tiles (manuscripts, reviews, avg score, avg turnaround —
    turnaround formatted as "3h 24m" under a day, otherwise "2.1 days").
  - The verdict bar chart (only rendered if `reviews > 0`).
  - `ScoreRadar` fed `dimensionAverages` (only rendered if it has ≥ 3
    dimensions, matching the component's own minimum).
  - An empty state ("No completed reviews yet") when `reviews === 0`.
- **`/settings`**: add a "Your activity" section below the existing profile
  form, rendering `<UserStatsPanel />` (self mode).
- **Admin**: add a `Stats` link per row in `AdminUsers.tsx` (next to the
  existing delete button) to a new `app/(dashboard)/admin/users/[userId]/page.tsx`
  — inherits the existing `admin/layout.tsx` role gate, renders
  `<UserStatsPanel userId={...} />` plus the user's name/email and a back link
  to `/admin`.

### 4. Testing

- Unit tests for `getUserStats`'s aggregation math (averaging, verdict
  counting, turnaround calc, zero-reviews empty state) with a mocked admin
  client, following the `tests/planGates.test.ts` mocking pattern.
- Build/test gate + manual click-through on both `/settings` and the new admin
  page.

## Out of scope (YAGNI)

- Time-range filtering / trend-over-time charts.
- Team-level aggregate stats (rolling up multiple users) — this is per-user only.
- Exporting stats (PDF/CSV) — no request for this.
