import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the one module that touches the SDK, so these tests do no network and
// never load anything that imports 'server-only'.
const h = vi.hoisted(() => ({ errors: [] as Array<{ error: unknown; ctx?: Record<string, unknown> }> }))
vi.mock('@/lib/monitoring/sentry', () => ({
  reportError: (error: unknown, ctx?: Record<string, unknown>) => h.errors.push({ error, ctx }),
  reportWarning: vi.fn(),
  flushMonitoring: vi.fn(),
}))

import { mustWrite, isReported } from '@/lib/db/mustWrite'

beforeEach(() => {
  h.errors = []
})

const ok = <T>(data: T) => Promise.resolve({ data, error: null })
const fail = (message: string, code?: string) =>
  Promise.resolve({ data: null, error: { message, code } })

describe('mustWrite', () => {
  it('returns data and reports nothing on success', async () => {
    await expect(mustWrite('label', ok([{ id: 'x' }]))).resolves.toEqual([{ id: 'x' }])
    expect(h.errors).toHaveLength(0)
  })

  it('throws when the write returned an error', async () => {
    await expect(
      mustWrite('persist routing', fail('column does not exist', '42703')),
    ).rejects.toThrow(/persist routing/)
  })

  it('reports the failure with its context identifiers', async () => {
    await mustWrite('persist routing', fail('boom', '42703'), { sessionId: 's1' }).catch(() => {})
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0].ctx).toMatchObject({
      sessionId: 's1',
      label: 'persist routing',
      code: '42703',
    })
  })

  it('tags the thrown error as already reported, so the outer catch does not duplicate it', async () => {
    // mustWrite reports AND throws; the pipeline's catch re-throws, which Sentry
    // would otherwise capture a second time as an unhandled rejection.
    const err = await mustWrite('x', fail('boom')).catch((e) => e)
    expect(isReported(err)).toBe(true)
    expect(isReported(new Error('unrelated'))).toBe(false)
  })

  it('isReported tolerates non-error values', () => {
    expect(isReported(null)).toBe(false)
    expect(isReported(undefined)).toBe(false)
    expect(isReported('a string')).toBe(false)
  })

  it('never puts row payloads in the report', async () => {
    await mustWrite('insert scores', fail('boom'), { sessionId: 's1', rowCount: 8 }).catch(() => {})
    expect(JSON.stringify(h.errors[0].ctx)).not.toMatch(/parsed_text|abstract/)
  })

  it('includes the underlying message in the thrown error', async () => {
    const err = await mustWrite('insert scores', fail('duplicate key')).catch((e) => e)
    expect((err as Error).message).toContain('duplicate key')
  })
})
