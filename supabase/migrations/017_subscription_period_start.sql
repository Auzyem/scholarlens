-- Record when the current billing period began.
--
-- `max_reviews_per_month` was being counted from the 1st of the calendar month,
-- which does not match what the customer bought: someone who subscribes on the
-- 28th got a full month's allowance for three days and a fresh one on the 1st.
-- Metering against the subscription's own period needs its start date, and we
-- only ever stored `current_period_end`.
--
-- Nullable on purpose: free-plan rows have no Stripe period, and the quota code
-- falls back to the calendar month for them (unchanged behaviour).
alter table public.subscriptions
  add column if not exists current_period_start timestamptz;

-- Existing paying rows stay null until their next sync. Rather than guess a
-- start date by subtracting an interval from current_period_end (wrong whenever
-- a plan was switched mid-period), leave them null — the calendar-month
-- fallback keeps metering them exactly as it does today, and each row corrects
-- itself on the next subscription webhook. To fill them immediately, run the
-- admin reconcile endpoint (POST /api/admin/billing/reconcile), which re-reads
-- every live subscription from Stripe and rewrites these rows.
