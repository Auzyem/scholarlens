-- annual_discount_pct was `integer`, but the admin console computes/accepts
-- fractional percentages (e.g. 16.67% for a $15/mo -> $12.50/mo annual price).
-- Every PATCH /api/admin/plans save that included a fractional discount was
-- rejected by Postgres with 22P02 "invalid input syntax for type integer",
-- which silently killed the rest of that save (name, feature toggles, limits)
-- even though the Stripe price sync a moment earlier had already succeeded.
alter table public.plans
  alter column annual_discount_pct type numeric(5,2) using annual_discount_pct::numeric(5,2);

alter table public.plans
  drop constraint if exists plans_annual_discount_pct_check;

alter table public.plans
  add constraint plans_annual_discount_pct_check check (annual_discount_pct between 0 and 100);
