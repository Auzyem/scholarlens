import { describe, it, expect } from 'vitest'
import { quotaWindowStart } from '@/lib/plan/period'

const at = (iso: string) => new Date(iso)

describe('quotaWindowStart', () => {
  it('falls back to the calendar month when there is no billing anchor', () => {
    // Free-plan rows have no Stripe period; behaviour must match what every
    // plan did before the anchor existed.
    expect(quotaWindowStart(null, at('2026-07-30T12:00:00Z')).toISOString())
      .toBe('2026-07-01T00:00:00.000Z')
    expect(quotaWindowStart(undefined, at('2026-07-30T12:00:00Z')).toISOString())
      .toBe('2026-07-01T00:00:00.000Z')
  })

  it('falls back to the calendar month on an unparseable anchor', () => {
    expect(quotaWindowStart('not-a-date', at('2026-07-30T12:00:00Z')).toISOString())
      .toBe('2026-07-01T00:00:00.000Z')
  })

  it('returns the anchor itself during the first period', () => {
    const anchor = '2026-07-28T09:15:00.000Z'
    expect(quotaWindowStart(anchor, at('2026-07-30T12:00:00Z')).toISOString()).toBe(anchor)
  })

  it('does NOT reset on the 1st of the calendar month', () => {
    // The bug this replaces: subscribing on the 28th granted a full allowance
    // for three days, then a fresh one on the 1st.
    const anchor = '2026-07-28T09:15:00.000Z'
    expect(quotaWindowStart(anchor, at('2026-08-01T00:00:00Z')).toISOString()).toBe(anchor)
  })

  it('rolls over on the monthly anniversary, not before', () => {
    const anchor = '2026-07-28T09:15:00.000Z'
    // One minute before the anniversary — still the July window.
    expect(quotaWindowStart(anchor, at('2026-08-28T09:14:00Z')).toISOString()).toBe(anchor)
    // On the anniversary — new window.
    expect(quotaWindowStart(anchor, at('2026-08-28T09:15:00Z')).toISOString())
      .toBe('2026-08-28T09:15:00.000Z')
  })

  it('keeps the window monthly for an annual subscriber', () => {
    // The period is a year long, but the plan sells reviews *per month*, so
    // metering against the period would grant twelve months of quota at once.
    const anchor = '2026-01-15T00:00:00.000Z'
    expect(quotaWindowStart(anchor, at('2026-07-20T00:00:00Z')).toISOString())
      .toBe('2026-07-15T00:00:00.000Z')
  })

  it('clamps the anniversary into short months', () => {
    // 31 Jan + 1 month is 28 Feb, not 3 Mar.
    const anchor = '2026-01-31T12:00:00.000Z'
    expect(quotaWindowStart(anchor, at('2026-02-28T13:00:00Z')).toISOString())
      .toBe('2026-02-28T12:00:00.000Z')
    // Earlier that same day the February window has not opened yet.
    expect(quotaWindowStart(anchor, at('2026-02-28T11:00:00Z')).toISOString())
      .toBe('2026-01-31T12:00:00.000Z')
    // March is long enough to honour the 31st again.
    expect(quotaWindowStart(anchor, at('2026-03-31T13:00:00Z')).toISOString())
      .toBe('2026-03-31T12:00:00.000Z')
  })

  it('handles a leap-year February', () => {
    const anchor = '2024-01-30T00:00:00.000Z'
    expect(quotaWindowStart(anchor, at('2024-02-29T06:00:00Z')).toISOString())
      .toBe('2024-02-29T00:00:00.000Z')
  })

  it('crosses a year boundary', () => {
    const anchor = '2025-11-05T08:00:00.000Z'
    expect(quotaWindowStart(anchor, at('2026-02-10T00:00:00Z')).toISOString())
      .toBe('2026-02-05T08:00:00.000Z')
  })

  it('counts from the anchor when the period has not started yet', () => {
    // Clock skew or a scheduled change written ahead of time: nothing can have
    // been consumed in a window that has not opened.
    const anchor = '2026-08-10T00:00:00.000Z'
    expect(quotaWindowStart(anchor, at('2026-08-01T00:00:00Z')).toISOString()).toBe(anchor)
  })

  it('is timezone-independent', () => {
    // Same instant expressed with an offset must give the same window.
    const utc = quotaWindowStart('2026-07-28T09:15:00.000Z', at('2026-08-30T00:00:00Z'))
    const offset = quotaWindowStart('2026-07-28T11:15:00.000+02:00', at('2026-08-30T00:00:00Z'))
    expect(offset.toISOString()).toBe(utc.toISOString())
  })

  it('spans the whole account lifetime when the plan does not reset', () => {
    // Free is a one-time allowance: the window starts the day the account was
    // created, so every event ever recorded still counts.
    const created = '2025-11-03T08:30:00.000Z'
    expect(
      quotaWindowStart(null, at('2026-07-30T12:00:00Z'), {
        resets: false,
        accountCreatedAt: created,
      }).toISOString()
    ).toBe(created)
  })

  it('ignores a billing anchor entirely when the plan does not reset', () => {
    // A downgraded account can still carry current_period_start from its paid
    // days; a non-resetting plan must not honour it.
    const created = '2025-11-03T08:30:00.000Z'
    expect(
      quotaWindowStart('2026-07-28T09:15:00.000Z', at('2026-07-30T12:00:00Z'), {
        resets: false,
        accountCreatedAt: created,
      }).toISOString()
    ).toBe(created)
  })

  it('falls back to the calendar month when non-resetting but the creation date is unusable', () => {
    expect(
      quotaWindowStart(null, at('2026-07-30T12:00:00Z'), {
        resets: false,
        accountCreatedAt: null,
      }).toISOString()
    ).toBe('2026-07-01T00:00:00.000Z')
  })

  it('behaves exactly as before when resets is true', () => {
    const anchor = '2026-07-28T09:15:00.000Z'
    expect(
      quotaWindowStart(anchor, at('2026-07-30T12:00:00Z'), {
        resets: true,
        accountCreatedAt: '2025-01-01T00:00:00.000Z',
      }).toISOString()
    ).toBe(anchor)
  })
})
