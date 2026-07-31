import * as Sentry from '@sentry/nextjs'
import { scrubValue } from './scrub'

/**
 * The only module that touches the Sentry SDK.
 *
 * Keeping the SDK behind this wrapper is what lets everything downstream —
 * `mustWrite` in particular — be unit-tested by mocking one module, with no
 * network and no SDK internals in the way.
 *
 * With no DSN configured Sentry is inert, so these degrade to console output.
 * That is exactly what we want in CI and local dev, where `npm run build` is
 * the merge gate and there are no Sentry environment variables at all.
 */

export function reportError(error: unknown, context?: Record<string, unknown>): void {
  const scrubbed = context ? (scrubValue(context) as Record<string, unknown>) : undefined
  console.error('[error]', error instanceof Error ? error.message : error, scrubbed ?? '')
  Sentry.captureException(error, scrubbed ? { extra: scrubbed } : undefined)
}

export function reportWarning(message: string, context?: Record<string, unknown>): void {
  const scrubbed = context ? (scrubValue(context) as Record<string, unknown>) : undefined
  console.warn('[warn]', message, scrubbed ?? '')
  Sentry.captureMessage(message, { level: 'warning', extra: scrubbed })
}

/**
 * Detached `waitUntil` pipelines outlive the HTTP response, and Vercel can
 * freeze the function the moment the promise settles — discarding buffered
 * events from exactly the code paths we most need visibility into. Every
 * detached pipeline must await this in a `finally`.
 */
export async function flushMonitoring(timeoutMs = 2000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs)
  } catch {
    // Never let a telemetry failure change the pipeline's own outcome.
  }
}
