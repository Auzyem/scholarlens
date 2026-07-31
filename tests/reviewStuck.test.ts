import { describe, it, expect } from 'vitest'
import {
  findStuckLifecycles,
  stuckErrorMessage,
  STUCK_THRESHOLD_MS,
  type ReviewSessionClocks,
} from '@/lib/review/stuck'

const NOW = new Date('2026-07-31T12:00:00.000Z')
/** A clock reading `mins` minutes before NOW. */
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString()

function row(overrides: Partial<ReviewSessionClocks> = {}): ReviewSessionClocks {
  return {
    id: 'sess-1',
    status: 'complete',
    status_updated_at: ago(1),
    adversarial_status: 'not_started',
    adversarial_status_updated_at: ago(1),
    journal_match_status: 'not_started',
    journal_match_status_updated_at: ago(1),
    reporting_check_status: 'not_started',
    reporting_check_status_updated_at: ago(1),
    ...overrides,
  }
}

describe('findStuckLifecycles — main pipeline', () => {
  it('reaps a session that died mid-review', () => {
    const found = findStuckLifecycles(row({ status: 'reviewing', status_updated_at: ago(30) }), NOW)
    expect(found).toEqual([{ column: 'status', clock: 'status_updated_at', from: 'reviewing' }])
  })

  it('reaps every non-terminal main status', () => {
    for (const s of ['queued', 'routing', 'reviewing', 'adversarial', 'matching', 'comparing']) {
      const found = findStuckLifecycles(row({ status: s, status_updated_at: ago(30) }), NOW)
      expect(found, `${s} should be reapable`).toHaveLength(1)
    }
  })

  it('NEVER reaps awaiting_confirmation, however old', () => {
    // The pipeline parks here deliberately when routing confidence is low and
    // waits for the user — this can legitimately sit for days. Reaping it would
    // destroy a live review that is behaving exactly as designed.
    const found = findStuckLifecycles(
      row({ status: 'awaiting_confirmation', status_updated_at: ago(60 * 24 * 30) }),
      NOW,
    )
    expect(found).toEqual([])
  })

  it('never reaps terminal statuses', () => {
    expect(findStuckLifecycles(row({ status: 'complete', status_updated_at: ago(999) }), NOW)).toEqual([])
    expect(findStuckLifecycles(row({ status: 'failed', status_updated_at: ago(999) }), NOW)).toEqual([])
  })

  it('leaves a running pipeline inside the threshold alone', () => {
    expect(findStuckLifecycles(row({ status: 'reviewing', status_updated_at: ago(4) }), NOW)).toEqual([])
  })
})

describe('findStuckLifecycles — threshold boundary', () => {
  const at = (ms: number) =>
    findStuckLifecycles(
      row({ status: 'reviewing', status_updated_at: new Date(NOW.getTime() - ms).toISOString() }),
      NOW,
    )

  it('reaps at exactly the threshold', () => {
    expect(at(STUCK_THRESHOLD_MS)).toHaveLength(1)
  })

  it('does not reap one millisecond early', () => {
    expect(at(STUCK_THRESHOLD_MS - 1)).toEqual([])
  })

  it('reaps one millisecond late', () => {
    expect(at(STUCK_THRESHOLD_MS + 1)).toHaveLength(1)
  })
})

describe('findStuckLifecycles — sub-pipelines', () => {
  it('reaps a stuck adversarial pass', () => {
    const found = findStuckLifecycles(
      row({ adversarial_status: 'running', adversarial_status_updated_at: ago(30) }),
      NOW,
    )
    expect(found).toEqual([
      { column: 'adversarial_status', clock: 'adversarial_status_updated_at', from: 'running' },
    ])
  })

  it('reaps a stuck journal match', () => {
    const found = findStuckLifecycles(
      row({ journal_match_status: 'running', journal_match_status_updated_at: ago(30) }),
      NOW,
    )
    expect(found.map(f => f.column)).toEqual(['journal_match_status'])
  })

  it('reaps a stuck reporting check', () => {
    const found = findStuckLifecycles(
      row({ reporting_check_status: 'running', reporting_check_status_updated_at: ago(30) }),
      NOW,
    )
    expect(found.map(f => f.column)).toEqual(['reporting_check_status'])
  })

  it('ignores sub-pipelines that are not running', () => {
    for (const s of ['not_started', 'complete', 'failed']) {
      const found = findStuckLifecycles(
        row({ adversarial_status: s, adversarial_status_updated_at: ago(999) }),
        NOW,
      )
      expect(found, `${s} should be ignored`).toEqual([])
    }
  })

  it('returns every stuck lifecycle when one instance kill took several down', () => {
    const found = findStuckLifecycles(
      row({
        status: 'reviewing', status_updated_at: ago(30),
        adversarial_status: 'running', adversarial_status_updated_at: ago(30),
        reporting_check_status: 'running', reporting_check_status_updated_at: ago(30),
      }),
      NOW,
    )
    expect(found.map(f => f.column).sort()).toEqual(
      ['adversarial_status', 'reporting_check_status', 'status'],
    )
  })

  it('reaps only the overdue lifecycle when others are fresh', () => {
    const found = findStuckLifecycles(
      row({
        status: 'reviewing', status_updated_at: ago(30),
        adversarial_status: 'running', adversarial_status_updated_at: ago(2),
      }),
      NOW,
    )
    expect(found.map(f => f.column)).toEqual(['status'])
  })
})

describe('findStuckLifecycles — unusable clocks', () => {
  it('leaves a row alone when its clock is missing', () => {
    // Fail safe: with no clock we cannot know how long it has been stuck, and
    // wrongly failing a live review is worse than leaving one for a human.
    expect(findStuckLifecycles(row({ status: 'reviewing', status_updated_at: null }), NOW)).toEqual([])
  })

  it('leaves a row alone when its clock is unparseable', () => {
    expect(findStuckLifecycles(row({ status: 'reviewing', status_updated_at: 'nonsense' }), NOW)).toEqual([])
  })
})

describe('stuckErrorMessage', () => {
  it('names the stage and says the quota was released', () => {
    const msg = stuckErrorMessage({ column: 'status', clock: 'status_updated_at', from: 'reviewing' })
    expect(msg).toContain('reviewing')
    expect(msg).toMatch(/does not count/i)
  })

  it('names each sub-pipeline in plain language', () => {
    expect(
      stuckErrorMessage({ column: 'adversarial_status', clock: 'adversarial_status_updated_at', from: 'running' }),
    ).toContain('adversarial critique')
  })
})
