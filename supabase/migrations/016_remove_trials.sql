-- Remove free trials entirely. The Pro plan used to pass `trial_period_days: 7`
-- to Stripe Checkout, which is what made Stripe's hosted checkout page show
-- "7 days free" before the first charge. No plan offers a trial any more, so the
-- trial bookkeeping comes out of the schema too:
--   * any row still parked in 'trialing' becomes 'active' (a trialing customer
--     had access, so keep it — Stripe bills them at the trial end either way),
--   * the subscriptions status constraint drops 'trialing',
--   * the now-unused trial_end column (added in 007) is dropped.

-- 1. Migrate existing trialing rows before tightening the constraint.
update public.subscriptions
   set status = 'active', updated_at = now()
 where status = 'trialing';

-- 2. Replace the status check constraint. 006 declared it inline, so its name is
--    whatever Postgres generated; find any check constraint on the table that
--    still mentions 'trialing' and drop it rather than guessing the name.
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'subscriptions'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%trialing%'
  loop
    execute format('alter table public.subscriptions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.subscriptions
  drop constraint if exists subscriptions_status_check;

alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in ('active','past_due','canceled','free'));

-- 3. Drop the trial column.
alter table public.subscriptions
  drop column if exists trial_end;
