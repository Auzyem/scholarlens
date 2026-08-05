-- Make reserving a review credit atomic.
--
-- The application checked the limit and inserted the reservation as two
-- separate round trips:
--
--     const limit = await checkReviewLimit(userId)   -- reads "1 of 2 used"
--     if (!limit.allowed) return 403
--     await insertReservation(...)                   -- writes
--
-- Nothing holds between them. N concurrent POSTs to /api/review/start all read
-- the same "under the limit", all pass, and all insert — so a user with one
-- credit left can run up to the hourly abuse cap (10) of reviews on it, each
-- costing real model spend. It is reachable from devtools.
--
-- Fixing it needs the check and the insert to be one indivisible step, which
-- means doing both inside the database.
--
-- The quota window and the plan limit are still computed in TypeScript and
-- passed in. That is deliberate: reimplementing quotaWindowStart's billing
-- anniversary arithmetic in PL/pgSQL would duplicate logic that already caused
-- trouble once (migration 018's partial index has to be kept in sync with
-- REAPABLE_MAIN_STATUSES by hand). This function decides nothing about policy —
-- it only enforces, atomically, the numbers it is given.

create or replace function public.reserve_review_credit(
  p_user_id uuid,
  p_window_start timestamptz,
  p_limit integer,           -- null means unlimited
  p_session_id uuid,
  p_stale_seconds integer
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
  v_id uuid;
begin
  -- Serialise every reservation attempt for this one user, for the life of the
  -- transaction. Concurrent callers queue here instead of racing the count
  -- below. Per-user rather than global, so unrelated users never block.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if p_limit is not null then
    -- Mirrors lib/plan/ledger.ts countUsage, including the staleness rule: a
    -- row still 'reserved' after p_stale_seconds belongs to a pipeline that
    -- died without releasing (the routes cap at 300s and the stuck-review
    -- reaper fires at 10 minutes, so an hour-old hold is not live work). It
    -- stops occupying the allowance rather than stranding the credit forever.
    -- If that review somehow does complete, commitReviewCredit consumes the
    -- row and it counts again — the rule is self-correcting.
    select count(*) into v_used
      from public.usage_events
     where user_id = p_user_id
       and kind = 'review'
       and window_start >= p_window_start
       and (
         state = 'consumed'
         or (state = 'reserved'
             and created_at > now() - make_interval(secs => p_stale_seconds))
       );

    if v_used >= p_limit then
      return null;   -- caller turns this into a 403
    end if;
  end if;

  insert into public.usage_events (user_id, kind, state, review_session_id, window_start)
  values (p_user_id, 'review', 'reserved', p_session_id, p_window_start)
  returning id into v_id;

  return v_id;
end;
$$;

-- Only the service role calls this; every application path already runs the
-- ledger through the admin client. Revoking the default grant keeps a logged-in
-- user from invoking it directly and minting themselves a reservation.
revoke execute on function public.reserve_review_credit(uuid, timestamptz, integer, uuid, integer) from public;
revoke execute on function public.reserve_review_credit(uuid, timestamptz, integer, uuid, integer) from anon;
revoke execute on function public.reserve_review_credit(uuid, timestamptz, integer, uuid, integer) from authenticated;
grant execute on function public.reserve_review_credit(uuid, timestamptz, integer, uuid, integer) to service_role;

-- Supports the count above: the lock serialises writers, but the count still
-- has to be fast or it becomes the bottleneck under the lock.
create index if not exists idx_usage_events_review_window
  on public.usage_events(user_id, kind, window_start, state);
