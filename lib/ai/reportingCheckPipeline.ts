import { createAdminClient } from '@/lib/supabase/admin'
import { mustWrite, isReported } from '@/lib/db/mustWrite'
import { reportError, flushMonitoring } from '@/lib/monitoring/sentry'
import { runReportingChecker } from './prompts/reportingChecker'
import { GUIDELINES, type ReportingGuidelineId } from '@/lib/reporting/guidelines'
import type { ChecklistItemStatus } from '@/lib/types'

// The DB CHECK constraint only accepts these four. The model is instructed to return them,
// but a stray value ('partially_present', 'PRESENT', 'n/a', …) would otherwise abort the
// entire batched insert with a CHECK violation — so coerce anything unexpected to 'missing',
// mirroring how unknown item codes already default to 'missing' below.
const ALLOWED_STATUSES = new Set<ChecklistItemStatus>(['present', 'partial', 'missing', 'not_applicable'])

export async function runReportingCheckPipeline(sessionId: string) {
  const supabase = createAdminClient()

  try {
    await mustWrite(
      'claim reporting check run',
      supabase.from('review_sessions').update({ reporting_check_status: 'running' }).eq('id', sessionId),
      { sessionId },
    )

    // Retries re-run this pass; rows are inserted, not upserted, so clear what a
    // previous attempt wrote or the checklist silently doubles — which is why
    // this delete failing must be loud rather than silent.
    await mustWrite(
      'clear prior checklist items',
      supabase.from('reporting_checklist_items').delete().eq('session_id', sessionId),
      { sessionId },
    )

    const { data: session, error } = await supabase
      .from('review_sessions')
      .select('*, drafts(*, manuscripts(*))')
      .eq('id', sessionId)
      .single()

    if (error || !session) throw new Error('Session not found')

    const guidelineId = session.reporting_guideline_id as ReportingGuidelineId | null
    const guideline = guidelineId ? GUIDELINES[guidelineId] : undefined
    if (!guideline) throw new Error('No guideline selected for this session')

    const draft = session.drafts as unknown as { parsed_text?: string }
    const manuscriptText = draft.parsed_text || ''

    const result = await runReportingChecker({ manuscriptText, guideline })

    // Build verdict lookup from the model, then iterate the CANONICAL items so the
    // row set is always complete even if the model omits one (default: missing).
    const byCode = new Map(result.items.map(i => [i.code, i]))
    const rows = guideline.items.map(item => {
      const verdict = byCode.get(item.code)
      const raw = verdict?.status
      const status: ChecklistItemStatus =
        raw && ALLOWED_STATUSES.has(raw as ChecklistItemStatus) ? (raw as ChecklistItemStatus) : 'missing'
      return {
        session_id: sessionId,
        guideline_id: guideline.id,
        item_code: item.code,
        section: item.section,
        requirement: item.requirement,
        status,
        evidence: verdict?.evidence ?? '',
        fix: verdict?.fix ?? '',
      }
    })
    if (rows.length > 0) {
      // supabase-js returns errors on the response rather than throwing, so an
      // unchecked failure here (a stale schema cache, an RLS denial, a CHECK
      // violation) would silently leave the session 'complete' with zero rows.
      // This file guarded against that by hand; mustWrite now does it uniformly
      // and reports the failure as well as surfacing it to the catch.
      await mustWrite(
        'insert checklist items',
        supabase.from('reporting_checklist_items').insert(rows),
        { sessionId, guidelineId: guideline.id, rowCount: rows.length },
      )
    }

    await mustWrite(
      'complete reporting check run',
      supabase
        .from('review_sessions')
        .update({ reporting_check_status: 'complete', reporting_summary: result.summary })
        .eq('id', sessionId),
      { sessionId },
    )
  } catch (err: unknown) {
    if (!isReported(err)) reportError(err, { sessionId, stage: 'reporting check' })
    // Deliberately NOT wrapped: nowhere left to escalate if this also fails,
    // and the reaper catches a session left in 'running'.
    await supabase
      .from('review_sessions')
      .update({ reporting_check_status: 'failed' })
      .eq('id', sessionId)
    throw err
  } finally {
    // Detached under waitUntil — flush before the function can freeze.
    await flushMonitoring()
  }
}
