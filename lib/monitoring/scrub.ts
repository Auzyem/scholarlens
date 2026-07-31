/**
 * Strips manuscript content out of anything on its way to Sentry.
 *
 * Manuscripts are unpublished academic work, so the default Sentry config is
 * not acceptable for this product. This module is pure and unit-tested
 * directly, because a scrubbing bug is a data leak and must not depend on
 * anyone remembering to check it by eye.
 *
 * Keyed on FIELD NAME, not value, so it stays correct as prompts and payload
 * shapes change.
 */

export const SENSITIVE_KEYS = [
  'parsed_text',
  'manuscriptText',
  'abstract',
  'title',
  'comment',
  'suggestion',
  'rationale',
  'strength_summary',
  'weakness_summary',
  'adversarial_summary',
  'reporting_summary',
] as const

export const REDACTED = '[redacted]'

/** Long strings are capped so text cannot ride out under an unexpected key. */
export const MAX_VALUE_LENGTH = 2048

const SENSITIVE = new Set<string>(SENSITIVE_KEYS)

function truncate(s: string): string {
  return s.length <= MAX_VALUE_LENGTH ? s : s.slice(0, MAX_VALUE_LENGTH) + '…[truncated]'
}

/**
 * Recursively redact sensitive keys and cap long strings.
 *
 * `seen` guards against circular structures — Sentry contexts are arbitrary
 * objects assembled at the call site, and the reporter must never be the thing
 * that crashes a request.
 */
export function scrubValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncate(value)
  if (typeof value !== 'object') return value

  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)

  if (Array.isArray(value)) return value.map((v) => scrubValue(v, seen))

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.has(k) ? REDACTED : scrubValue(v, seen)
  }
  return out
}

/**
 * Strip local-variable values off stack frames.
 *
 * Sentry's LocalVariables integration attaches the *values* of locals to frames
 * on an uncaught exception. `manuscriptText`, `parsed_text` and `abstract` are
 * all locals inside the pipeline functions, so this is a direct route for
 * manuscript content to leave the process — and one that no amount of scrubbing
 * `extra` or `contexts` would catch.
 *
 * The integration is also disabled in the runtime configs. This is the
 * belt-and-braces half: filenames and line numbers are what we actually need
 * for debugging, and variable values are never worth the risk here.
 */
function stripFrameVars(event: Record<string, unknown>): void {
  const exception = event.exception as { values?: Array<Record<string, unknown>> } | undefined
  for (const value of exception?.values ?? []) {
    const stacktrace = value.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined
    for (const frame of stacktrace?.frames ?? []) {
      delete frame.vars
    }
  }
}

/** Sentry `beforeSend`: scrub extra, contexts, breadcrumbs and frame locals. */
export function scrubEvent<T extends Record<string, unknown>>(event: T): T {
  const e = event as Record<string, unknown>
  stripFrameVars(e)
  if (e.extra) e.extra = scrubValue(e.extra)
  if (e.contexts) e.contexts = scrubValue(e.contexts)
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = (e.breadcrumbs as Array<Record<string, unknown>>).map((b) => ({
      ...b,
      data: b.data ? scrubValue(b.data) : b.data,
    }))
  }
  // Request bodies are never attached; drop defensively in case a future SDK
  // default changes.
  if (e.request && typeof e.request === 'object') {
    const req = { ...(e.request as Record<string, unknown>) }
    delete req.data
    delete req.cookies
    e.request = req
  }
  return event
}
