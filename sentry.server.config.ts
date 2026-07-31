import * as Sentry from '@sentry/nextjs'
import { scrubEvent, scrubValue } from '@/lib/monitoring/scrub'

// An absent DSN disables Sentry rather than throwing. `npm run build` is the
// merge gate and CI has no Sentry variables at all — the same failure shape the
// Stripe client guards against with its build-only placeholder key.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),

  // Manuscripts are unpublished work: no PII, no request bodies, no tracing.
  sendDefaultPii: false,
  tracesSampleRate: 0,
  maxValueLength: 2048,

  // scrubEvent mutates in place, so the original event is returned to keep the
  // SDK's own event type rather than casting through a looser shape.
  beforeSend: (event) => {
    scrubEvent(event as unknown as Record<string, unknown>)
    return event
  },
  beforeBreadcrumb: (crumb) => {
    if (crumb.data) crumb.data = scrubValue(crumb.data) as typeof crumb.data
    return crumb
  },
})
