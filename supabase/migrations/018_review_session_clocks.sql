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
--
-- This status list is duplicated from REAPABLE_MAIN_STATUSES in
-- lib/review/stuck.ts (SQL cannot import from TypeScript). If a status is ever
-- added to the main lifecycle, update both. A mismatch degrades the query plan
-- rather than correctness, which is exactly why it would go unnoticed.
create index if not exists review_sessions_sweep_idx
  on public.review_sessions (status_updated_at)
  where status in ('queued','routing','reviewing','adversarial','matching','comparing');
