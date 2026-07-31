import { createAdminClient } from '@/lib/supabase/admin'
import { mustWrite, isReported } from '@/lib/db/mustWrite'
import { reportError, flushMonitoring } from '@/lib/monitoring/sentry'
import { runAdversarialReviewer, buildPriorReviewContext } from './prompts/adversarialReviewer'
import type { ReviewerPersona, Score } from '@/lib/types'

export async function runAdversarialPipeline(sessionId: string) {
  const supabase = createAdminClient()

  try {
    await mustWrite(
      'claim adversarial run',
      supabase.from('review_sessions').update({ adversarial_status: 'running' }).eq('id', sessionId),
      { sessionId },
    )

    // This pass can legitimately run more than once (a retry after a failure or
    // after the reaper). Rows are written with a plain insert, so clear what a
    // previous attempt wrote or the critique list silently doubles — which is
    // why this delete failing must be loud rather than silent.
    await mustWrite(
      'clear prior critiques',
      supabase.from('adversarial_critiques').delete().eq('session_id', sessionId),
      { sessionId },
    )

    const { data: session, error } = await supabase
      .from('review_sessions')
      .select('*, scores(*), drafts(*, manuscripts(*))')
      .eq('id', sessionId)
      .single()

    if (error || !session) throw new Error('Session not found')

    const draft = session.drafts as unknown as {
      parsed_text?: string
      manuscripts: { field?: string }
    }

    const manuscriptText = draft.parsed_text || ''
    if (!manuscriptText.trim()) throw new Error('Draft has no parsed text')

    const field = draft.manuscripts.field || 'this field'
    const persona = (session.reviewer_persona as ReviewerPersona) || 'social_science_quant'
    const scores = (session.scores as Score[]) || []
    const priorReviewContext = buildPriorReviewContext(
      scores,
      session.weakness_summary || undefined
    )

    const result = await runAdversarialReviewer(manuscriptText, persona, field, priorReviewContext)

    const critiqueRows = result.critiques.map((c, i) => ({
      session_id: sessionId,
      critique_number: i + 1,
      severity: c.severity,
      title: c.title,
      quoted_passage: c.quoted_passage,
      objection: c.objection,
      required_fix: c.required_fix,
      section_reference: c.section_reference,
    }))
    if (critiqueRows.length > 0) {
      await mustWrite(
        'insert critiques',
        supabase.from('adversarial_critiques').insert(critiqueRows),
        { sessionId, rowCount: critiqueRows.length },
      )
    }

    await mustWrite(
      'complete adversarial run',
      supabase
        .from('review_sessions')
        .update({ adversarial_status: 'complete', adversarial_summary: result.summary })
        .eq('id', sessionId),
      { sessionId },
    )
  } catch (err: unknown) {
    if (!isReported(err)) reportError(err, { sessionId, stage: 'adversarial' })
    // Deliberately NOT wrapped: nowhere left to escalate if this also fails,
    // and the reaper catches a session left in 'running'.
    await supabase
      .from('review_sessions')
      .update({ adversarial_status: 'failed' })
      .eq('id', sessionId)
    throw err
  } finally {
    // Detached under waitUntil — flush before the function can freeze.
    await flushMonitoring()
  }
}
