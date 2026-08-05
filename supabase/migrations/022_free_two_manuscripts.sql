-- Give the Free plan a second manuscript slot.
--
-- Free allows 2 lifetime reviews but only 1 manuscript, and since migration 019
-- a slot is charged permanently once its first review completes. That
-- combination meant a free user's second review had to be a re-review of the
-- same paper — a second manuscript was refused at the manuscript gate even
-- though they still held an unspent review credit.
--
-- Two slots lets the two free reviews be spent on two different papers, which
-- is what the allowance reads like from the outside.

update public.plans set max_manuscripts = 2 where id = 'free';
