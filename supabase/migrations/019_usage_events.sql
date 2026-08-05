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
