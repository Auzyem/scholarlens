import * as Sentry from '@sentry/nextjs'
import { scrubEvent, scrubValue } from '@/lib/monitoring/scrub'

// The edge runtime is initialised separately from the server one — this is not
// shared with sentry.server.config.ts, so the scrubbing rules are imported from
// the same module rather than duplicated, to stop them drifting apart.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),

  sendDefaultPii: false,
  tracesSampleRate: 0,
  maxValueLength: 2048,

  // Drop the LocalVariables integration entirely. It attaches the VALUES of
  // local variables to stack frames on an uncaught exception, and
  // manuscriptText / parsed_text / abstract are all locals inside the review
  // pipelines — a direct route for unpublished work to leave the process.
  // scrubEvent also strips frames[].vars as a second line of defence.
  integrations: (defaults) =>
    defaults.filter((i) => !i.name.startsWith('LocalVariables')),

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
