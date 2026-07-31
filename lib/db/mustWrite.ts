import { reportError } from '@/lib/monitoring/sentry'

/**
 * Run a supabase write and refuse to let a failure pass silently.
 *
 * supabase-js does not throw; it returns `{ data, error }`. Thirteen awaited
 * writes in lib/ai/*.ts discarded that error, which is how a failed
 * `routing_confidence` write left every review using the fallback reviewer
 * persona for weeks with nothing to show for it — and why an exception tracker
 * alone would not have caught the bug that motivated adding one.
 *
 * Throwing is deliberate. The pipelines already wrap their work in try/catch
 * blocks that write `status = 'failed'`, so a failed write becomes a visibly
 * failed, retryable review through machinery that already exists rather than a
 * parallel error path. And if the failure-write itself also fails, the session
 * stays in a running state and the stuck-review reaper catches it within ten
 * minutes.
 *
 * Takes a promise rather than a Supabase client so it imports nothing that
 * pulls in `server-only`, keeping it trivially testable.
 */

const REPORTED = Symbol.for('scholarlens.reported')

/** True if this error was already sent to Sentry by `mustWrite`. */
export function isReported(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[REPORTED])
}

export async function mustWrite<T>(
  label: string,
  op: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
  context?: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await op
  if (!error) return data

  const thrown = new Error(`${label} failed: ${error.message}`)
  ;(thrown as unknown as Record<symbol, unknown>)[REPORTED] = true

  // Identifiers only — never row payloads. The scrubbing layer is a backstop,
  // not a licence to pass content through here.
  reportError(thrown, { ...context, label, code: error.code })
  throw thrown
}
