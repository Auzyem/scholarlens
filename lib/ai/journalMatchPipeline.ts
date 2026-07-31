import { createAdminClient } from '@/lib/supabase/admin'
import { mustWrite, isReported } from '@/lib/db/mustWrite'
import { reportError, flushMonitoring } from '@/lib/monitoring/sentry'
import { runJournalMatcher } from './prompts/journalMatcher'

export async function runJournalMatchPipeline(sessionId: string) {
  const supabase = createAdminClient()

  try {
    await mustWrite(
      'claim journal match run',
      supabase.from('review_sessions').update({ journal_match_status: 'running' }).eq('id', sessionId),
      { sessionId },
    )

    // Retries re-run this pass; rows are inserted, not upserted, so clear what a
    // previous attempt wrote or the match list silently doubles — which is why
    // this delete failing must be loud rather than silent.
    await mustWrite(
      'clear prior journal matches',
      supabase.from('journal_matches').delete().eq('session_id', sessionId),
      { sessionId },
    )

    const { data: session, error } = await supabase
      .from('review_sessions')
      .select('*, drafts(*, manuscripts(*))')
      .eq('id', sessionId)
      .single()

    if (error || !session) throw new Error('Session not found')

    const draft = session.drafts as unknown as {
      manuscripts: {
        user_id: string
        title?: string
        field?: string
        subfield?: string
        doc_type?: string
      }
    }
    const manuscript = draft.manuscripts

    // career stage personalises the prestige/acceptance trade-off
    const { data: profile } = await supabase
      .from('profiles')
      .select('career_stage')
      .eq('id', manuscript.user_id)
      .single()

    const result = await runJournalMatcher({
      title: manuscript.title || '',
      field: manuscript.field || 'this field',
      subfield: manuscript.subfield || undefined,
      docType: manuscript.doc_type || undefined,
      overallScore: session.overall_score ?? undefined,
      strengthSummary: session.strength_summary || undefined,
      weaknessSummary: session.weakness_summary || undefined,
      careerStage: profile?.career_stage || undefined,
    })

    const rows = result.journals.map((j, i) => ({
      session_id: sessionId,
      rank: j.rank ?? i + 1,
      journal_name: j.journal_name,
      publisher: j.publisher,
      fit_score: j.fit_score,
      acceptance_band: j.acceptance_band,
      impact_factor_range: j.impact_factor_range,
      avg_decision_days: j.avg_decision_days,
      key_change_required: j.key_change_required,
      open_access_options: j.open_access_options,
      apc_cost: j.apc_cost,
      rationale: j.rationale,
    }))
    if (rows.length > 0) {
      await mustWrite('insert journal matches', supabase.from('journal_matches').insert(rows), {
        sessionId,
        rowCount: rows.length,
      })
    }

    await mustWrite(
      'complete journal match run',
      supabase.from('review_sessions').update({ journal_match_status: 'complete' }).eq('id', sessionId),
      { sessionId },
    )
  } catch (err: unknown) {
    if (!isReported(err)) reportError(err, { sessionId, stage: 'journal match' })
    // Deliberately NOT wrapped: nowhere left to escalate if this also fails,
    // and the reaper catches a session left in 'running'.
    await supabase
      .from('review_sessions')
      .update({ journal_match_status: 'failed' })
      .eq('id', sessionId)
    throw err
  } finally {
    // Detached under waitUntil — flush before the function can freeze.
    await flushMonitoring()
  }
}
