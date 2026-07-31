import { describe, it, expect } from 'vitest'
import { scrubValue, scrubEvent, SENSITIVE_KEYS, MAX_VALUE_LENGTH } from '@/lib/monitoring/scrub'

const MANUSCRIPT = 'Unpublished findings on soil moisture retention under cover crops.'

describe('scrubValue — denylisted keys', () => {
  it('removes every sensitive key at the top level', () => {
    const input: Record<string, unknown> = { sessionId: 'abc' }
    for (const k of SENSITIVE_KEYS) input[k] = MANUSCRIPT
    const out = scrubValue(input) as Record<string, unknown>

    expect(out.sessionId).toBe('abc')
    for (const k of SENSITIVE_KEYS) {
      expect(String(out[k]), `${k} must be redacted`).not.toContain('soil moisture')
    }
  })

  it('removes sensitive keys nested inside objects', () => {
    const out = scrubValue({ ctx: { draft: { parsed_text: MANUSCRIPT, id: 'd1' } } })
    expect(JSON.stringify(out)).not.toContain('soil moisture')
    expect(JSON.stringify(out)).toContain('d1')
  })

  it('removes sensitive keys inside arrays of objects', () => {
    const out = scrubValue({ rows: [{ comment: MANUSCRIPT }, { comment: MANUSCRIPT }] })
    expect(JSON.stringify(out)).not.toContain('soil moisture')
  })

  it('keeps non-sensitive identifiers untouched', () => {
    const out = scrubValue({ sessionId: 's1', status: 'reviewing', code: '42703' })
    expect(out).toEqual({ sessionId: 's1', status: 'reviewing', code: '42703' })
  })
})

describe('scrubValue — truncation', () => {
  it('truncates an over-long string even under a safe key', () => {
    // Defence against manuscript text arriving under an unexpected key name.
    const long = 'x'.repeat(MAX_VALUE_LENGTH + 500)
    const out = scrubValue({ note: long }) as Record<string, string>
    expect(out.note.length).toBeLessThanOrEqual(MAX_VALUE_LENGTH + 20)
    expect(out.note).toContain('[truncated]')
  })

  it('leaves a short string alone', () => {
    expect(scrubValue({ note: 'fine' })).toEqual({ note: 'fine' })
  })
})

describe('scrubValue — robustness', () => {
  it('handles null and undefined', () => {
    expect(scrubValue(null)).toBeNull()
    expect(scrubValue(undefined)).toBeUndefined()
  })

  it('does not throw on a circular structure', () => {
    const a: Record<string, unknown> = { id: 'x' }
    a.self = a
    expect(() => scrubValue(a)).not.toThrow()
  })

  it('passes a clean event through unchanged', () => {
    const clean = { sessionId: 's1', table: 'review_sessions' }
    expect(scrubValue(clean)).toEqual(clean)
  })
})

describe('scrubEvent', () => {
  it('scrubs extra, contexts and breadcrumb data', () => {
    const event = {
      extra: { parsed_text: MANUSCRIPT, sessionId: 's1' },
      contexts: { draft: { abstract: MANUSCRIPT } },
      breadcrumbs: [{ message: 'x', data: { title: MANUSCRIPT } }],
    }
    const out = scrubEvent(event as unknown as Record<string, unknown>)
    expect(JSON.stringify(out)).not.toContain('soil moisture')
    expect(JSON.stringify(out)).toContain('s1')
  })

  it('drops request body and cookies defensively', () => {
    const event = { request: { url: 'https://x/y', data: { parsed_text: MANUSCRIPT }, cookies: { sb: 'tok' } } }
    const out = scrubEvent(event as unknown as Record<string, unknown>) as Record<string, Record<string, unknown>>
    expect(out.request.data).toBeUndefined()
    expect(out.request.cookies).toBeUndefined()
    expect(out.request.url).toBe('https://x/y')
  })

  it('tolerates an event with none of those fields', () => {
    expect(() => scrubEvent({ message: 'hello' })).not.toThrow()
  })

  it('strips local-variable values off stack frames', () => {
    // Sentry's LocalVariables integration attaches the VALUES of locals to
    // frames on an uncaught exception. manuscriptText / parsed_text / abstract
    // are all locals inside the review pipelines, so this is a direct leak path
    // that scrubbing extra and contexts would never catch.
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: 'pipeline.ts', lineno: 120, vars: { manuscriptText: MANUSCRIPT } },
                { filename: 'other.ts', lineno: 3 },
              ],
            },
          },
        ],
      },
    }
    const out = scrubEvent(event as unknown as Record<string, unknown>)
    expect(JSON.stringify(out)).not.toContain('soil moisture')
    // The frame itself must survive — filenames and line numbers are the point.
    expect(JSON.stringify(out)).toContain('pipeline.ts')
    expect(JSON.stringify(out)).toContain('120')
  })

  it('tolerates malformed exception shapes', () => {
    expect(() => scrubEvent({ exception: {} })).not.toThrow()
    expect(() => scrubEvent({ exception: { values: [{}] } })).not.toThrow()
    expect(() => scrubEvent({ exception: { values: [{ stacktrace: {} }] } })).not.toThrow()
  })
})
