/**
 * Where the current usage-quota window starts.
 *
 * Plans advertise `max_reviews_per_month`, so the window is always a month long
 * — but it is anchored to the subscription, not the calendar. Counting from the
 * 1st gave someone who subscribed on the 28th a full allowance for three days
 * and a fresh one on the 1st.
 *
 * The anchor is the billing period start, and the window is its most recent
 * *monthly* anniversary. Using the monthly anniversary rather than the billing
 * period itself is what keeps annual subscribers honest: their period is a year
 * long, so metering against it would hand them twelve months of reviews on day
 * one. Their quota rolls on the same day-of-month they signed up.
 *
 * All arithmetic is UTC so the result doesn't shift with the server's timezone.
 */

/** Add months in UTC, clamping the day (31 Jan + 1 month = 28 Feb, not 3 Mar). */
function addMonthsUtc(base: Date, months: number): Date {
  const year = base.getUTCFullYear()
  const month = base.getUTCMonth() + months
  // Day 0 of the following month is the last day of the target month. Date.UTC
  // normalises month overflow, so this is safe for any `months` value.
  const daysInTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(base.getUTCDate(), daysInTargetMonth),
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds(),
    ),
  )
}

/** First instant of the calendar month containing `now` (UTC). */
function calendarMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/**
 * @param periodStartIso `subscriptions.current_period_start`, or null/absent for
 *   free-plan rows and rows not yet re-synced since migration 017.
 * @returns the instant the caller's current quota window began. Falls back to
 *   the calendar month when there is no billing anchor — the free plan has no
 *   Stripe period, and that is the behaviour every plan had before this.
 */
export function quotaWindowStart(periodStartIso: string | null | undefined, now: Date): Date {
  if (!periodStartIso) return calendarMonthStart(now)

  const anchor = new Date(periodStartIso)
  if (Number.isNaN(anchor.getTime())) return calendarMonthStart(now)

  // A period that hasn't begun yet (clock skew, or a scheduled change written
  // ahead of time): nothing can have been used in it, so count from the anchor.
  if (anchor.getTime() > now.getTime()) return anchor

  const monthsElapsed =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth())

  // Month-difference alone overshoots when `now` is earlier in the month than
  // the anchor day (anchor 31 Jan, now 28 Feb → the window is still January's).
  const candidate = addMonthsUtc(anchor, monthsElapsed)
  return candidate.getTime() > now.getTime() ? addMonthsUtc(anchor, monthsElapsed - 1) : candidate
}
