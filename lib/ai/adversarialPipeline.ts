import { createAdminClient } from '@/lib/supabase/admin'
import { runAdversarialReviewer, buildPriorReviewContext } from './prompts/adversarialReviewer'
import type { ReviewerPersona, Score } from '@/lib/types'

export async function runAdversarialPipeline(sessionId: string) {
  const supabase = createAdminClient()

  try {
    await supabase
      .from('review_sessions')
      .update({ adversarial_status: 'running' })
      .eq('id', sessionId)

    // This pass can legitimately run more than once (a retry after a failure or
    // after the reaper). Rows are written with a plain insert, so clear what a
    // previous attempt wrote or the critique list silently doubles.
    await supabase.from('adversarial_critiques').delete().eq('session_id', sessionId)

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
      await supabase.from('adversarial_critiques').insert(critiqueRows)
    }

    await supabase
      .from('review_sessions')
      .update({ adversarial_status: 'complete', adversarial_summary: result.summary })
      .eq('id', sessionId)
  } catch (err: unknown) {
    await supabase
      .from('review_sessions')
      .update({ adversarial_status: 'failed' })
      .eq('id', sessionId)
    throw err
  }
}
