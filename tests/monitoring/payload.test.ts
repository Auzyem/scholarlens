import { describe, it, expect, beforeAll } from 'vitest'
import * as Sentry from '@sentry/nextjs'
import { scrubEvent, scrubValue } from '@/lib/monitoring/scrub'

/**
 * End-to-end scrubbing check against the REAL SDK.
 *
 * tests/monitoring/scrub.test.ts proves the scrubbing function is correct in
 * isolation. That is not the same as proving nothing leaks: the function could
 * be right and still be wired into `beforeSend` wrongly, or the SDK could
 * attach content of its own after we hand the event back.
 *
 * So this test runs a real Sentry client configured exactly as
 * sentry.server.config.ts does, with a transport that captures the outgoing
 * envelope instead of sending it, and asserts on the bytes that would have left
 * the process. No DSN and no network required.
 */

const MANUSCRIPT =
  'Unpublished results: cover crops raised volumetric soil moisture by 3.1 points (p=0.04).'
const SECRET_TITLE = 'Soil Moisture Retention Under Three Cover-Crop Regimes'

const captured: unknown[] = []

beforeAll(async () => {
  Sentry.init({
    // Well-formed but fake — the capturing transport means nothing is sent.
    dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
    enabled: true,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxValueLength: 2048,
    transport: () => ({
      send: async (envelope: unknown) => {
        captured.push(envelope)
        return {}
      },
      flush: async () => true,
    }),
    // Identical to the runtime configs.
    beforeSend: (event) => {
      scrubEvent(event as unknown as Record<string, unknown>)
      return event
    },
    beforeBreadcrumb: (crumb) => {
      if (crumb.data) crumb.data = scrubValue(crumb.data) as typeof crumb.data
      return crumb
    },
  })

  Sentry.addBreadcrumb({
    message: 'loaded draft',
    data: { parsed_text: MANUSCRIPT, sessionId: 's-123' },
  })

  Sentry.captureException(new Error('persist reviewer persona failed: boom'), {
    extra: {
      sessionId: 's-123',
      label: 'persist reviewer persona',
      code: '42703',
      parsed_text: MANUSCRIPT,
      abstract: MANUSCRIPT,
      title: SECRET_TITLE,
    },
    contexts: {
      draft: { manuscripts: { title: SECRET_TITLE, abstract: MANUSCRIPT } },
    },
  })

  await Sentry.flush(3000)
})

describe('what actually leaves the process', () => {
  it('sends an envelope at all (the test would be vacuous otherwise)', () => {
    expect(captured.length).toBeGreaterThan(0)
  })

  it('contains no manuscript body text', () => {
    const wire = JSON.stringify(captured)
    expect(wire).not.toContain('volumetric soil moisture')
    expect(wire).not.toContain('Unpublished results')
  })

  it('contains no manuscript title', () => {
    expect(JSON.stringify(captured)).not.toContain('Cover-Crop Regimes')
  })

  it('still carries the identifiers needed to debug', () => {
    const wire = JSON.stringify(captured)
    expect(wire).toContain('s-123')
    expect(wire).toContain('42703')
    expect(wire).toContain('persist reviewer persona')
  })
})
