import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { requirePermission, permissionErrorResponse } from '@/lib/admin/permissions'
import { flushMonitoring } from '@/lib/monitoring/sentry'

/**
 * TEMPORARY smoke test for the error-monitoring wiring. DELETE AFTER USE.
 *
 * Every other route checks auth before touching its input, so there is no
 * harmless way to provoke a real 500 in production — and breaking production to
 * test monitoring is the wrong trade. This route provokes one deliberately,
 * behind the strictest existing permission, and reports the Sentry event id so
 * the event can be found in the dashboard and inspected for leaks.
 *
 * It deliberately attaches manuscript-shaped content to EVERY channel a leak
 * could use:
 *   - `extra`
 *   - `contexts`
 *   - a breadcrumb's `data`
 *   - a local variable in the throwing frame (the LocalVariables path that the
 *     offline payload check caught and that the runtime configs now disable)
 *
 * A correctly configured project shows the event with its identifiers intact
 * (sessionId, code, label) and none of the manuscript text.
 */

// Depends on the caller's session cookie; never prerender it.
export const dynamic = 'force-dynamic'

const CANARY = 'CANARY-MANUSCRIPT-TEXT-should-never-appear-in-Sentry-volumetric-soil-moisture'
const CANARY_TITLE = 'CANARY-TITLE-Soil-Moisture-Retention-Under-Three-Cover-Crop-Regimes'

/** Throws with the canary held in a local, so LocalVariables would capture it. */
function throwWithManuscriptInScope(): never {
  const manuscriptText = CANARY
  const abstract = CANARY
  // Referenced so the compiler cannot elide them from the frame.
  if (manuscriptText.length + abstract.length > 0) {
    throw new Error('sentry smoke test: deliberate failure with manuscript in scope')
  }
  throw new Error('unreachable')
}

export async function GET() {
  try {
    // Highest-privilege existing permission — this must never be reachable by
    // an ordinary user, even briefly.
    await requirePermission('system.manage_settings')
  } catch (e) {
    return permissionErrorResponse(e)
  }

  Sentry.addBreadcrumb({
    message: 'sentry smoke test: loaded draft',
    data: { parsed_text: CANARY, sessionId: 'smoke-test-session' },
  })

  let eventId: string | undefined
  try {
    throwWithManuscriptInScope()
  } catch (err) {
    eventId = Sentry.captureException(err, {
      extra: {
        sessionId: 'smoke-test-session',
        label: 'sentry smoke test',
        code: '42703',
        parsed_text: CANARY,
        abstract: CANARY,
        title: CANARY_TITLE,
      },
      contexts: {
        draft: { manuscripts: { title: CANARY_TITLE, abstract: CANARY } },
      },
    })
  }

  await flushMonitoring(5000)

  return NextResponse.json({
    ok: true,
    eventId,
    whatToCheck: {
      findIt: `Sentry → Issues → search: ${eventId}`,
      mustBeAbsent: ['CANARY-MANUSCRIPT-TEXT', 'CANARY-TITLE', 'volumetric-soil-moisture'],
      mustBePresent: ['smoke-test-session', '42703', 'sentry smoke test'],
      alsoCheck: 'no `vars` on any stack frame',
    },
  })
}
