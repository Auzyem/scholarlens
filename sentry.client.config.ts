import * as Sentry from '@sentry/nextjs'
import { scrubEvent, scrubValue } from '@/lib/monitoring/scrub'

// Browser runtime. Session replay is explicitly disabled: it would capture the
// manuscript text on screen, which re-opens the data-egress question this
// design deliberately closed.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),

  sendDefaultPii: false,
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
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
