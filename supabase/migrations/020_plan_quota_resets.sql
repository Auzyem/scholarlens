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
