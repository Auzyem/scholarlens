import { createAdminClient } from '@/lib/supabase/admin'
import { mustWrite, isReported } from '@/lib/db/mustWrite'
import { reportError, reportWarning, flushMonitoring } from '@/lib/monitoring/sentry'
import { runDisciplineRouter } from './prompts/disciplineRouter'
import { runDeepReviewer } from './prompts/deepReviewer'
import { runProgressComparator } from './prompts/progressComparator'
import { commitReviewCredit, releaseReviewCredit, resolveQuotaContext } from '@/lib/plan/ledger'
import type { ReviewStatus, ReviewerPersona, Score, Annotation } from '@/lib/types'

// Below this routing confidence we pause for the user to confirm/override the
// detected field before spending tokens on a possibly-misrouted deep review (#6).
export const CONFIDENCE_THRESHOLD = 0.7

type DraftWithManuscript = {
  parsed_text?: string
  version_number?: number
  manuscripts: {
    id: string
    title?: string
    abstract?: string
    field?: string
    submission_target?: string
    user_id: string
  }
}

/**
 * Stage 1: discipline routing. Persists the detected metadata and persona.
 * If the router is confident, continues straight into the deep review; if not,
 * parks the session at 'awaiting_confirmation' for the user to confirm the field.
 */
export async function runReviewPipeline(sessionId: string) {
  const supabase = createAdminClient()

  const updateStatus = async (status: ReviewStatus) => {
    await mustWrite(
      'update session status',
      supabase.from('review_sessions').update({ status }).eq('id', sessionId),
      { sessionId, status },
    )
  }

  try {
    const { data: session, error } = await supabase
      .from('review_sessions')
      .select('*, drafts(*, manuscripts(*))')
      .eq('id', sessionId)
      .single()

    if (error || !session) throw new Error('Session not found')

    const draft = session.drafts as unknown as DraftWithManuscript
    const manuscript = draft.manuscripts
    const title = manuscript.title || ''
    const abstract = manuscript.abstract || ''

    await updateStatus('routing')
    const routing = await runDisciplineRouter(title, abstract)

    await mustWrite(
      'persist routing metadata',
      supabase.from('manuscripts').update({
        field: routing.field,
        subfield: routing.subfield,
        doc_type: routing.doc_type,
      }).eq('id', manuscript.id),
      { sessionId, manuscriptId: manuscript.id },
    )

    // The write that silently failed for weeks: routing_confidence did not
    // exist, so the whole update was rejected, reviewer_persona was never
    // saved, and every review fell back to the default persona.
    await mustWrite(
      'persist reviewer persona',
      supabase.from('review_sessions').update({
        reviewer_persona: routing.persona,
        routing_confidence: routing.confidence,
      }).eq('id', sessionId),
      { sessionId, persona: routing.persona },
    )

    if (routing.confidence < CONFIDENCE_THRESHOLD) {
      // Pause for human confirmation; the confirm route resumes via runDeepReviewStage.
      await updateStatus('awaiting_confirmation')
      return
    }

    await runDeepReviewStage(sessionId)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    // mustWrite already reported its own failures; don't send a duplicate.
    if (!isReported(err)) reportError(err, { sessionId, stage: 'routing' })
    // Deliberately NOT wrapped in mustWrite: if the failure-write itself fails
    // there is nowhere left to escalate, and throwing from a catch would mask
    // the original error. The session then stays in a running state and the
    // stuck-review reaper picks it up within 10 minutes.
    await supabase.from('review_sessions').update({
      status: 'failed',
      error_message: message,
    }).eq('id', sessionId)
    // A review that produced nothing must not be charged.
    await releaseReviewCredit(sessionId)
    throw err
  } finally {
    // This pipeline runs detached under waitUntil; Vercel can freeze the
    // function the moment it settles, discarding buffered events.
    await flushMonitoring()
  }
}

/**
 * Stage 2: the deep review. Self-contained (reloads its own inputs) so it can be
 * triggered both by the pipeline (high confidence) and by the confirm route
 * (after the user confirms the field on a low-confidence routing).
 */
export async function runDeepReviewStage(sessionId: string) {
  const supabase = createAdminClient()

  try {
    await mustWrite(
      'mark session reviewing',
      supabase.from('review_sessions').update({ status: 'reviewing' }).eq('id', sessionId),
      { sessionId },
    )

    const { data: session, error } = await supabase
      .from('review_sessions')
      .select('*, drafts(*, manuscripts(*))')
      .eq('id', sessionId)
      .single()

    if (error || !session) throw new Error('Session not found')

    const draft = session.drafts as unknown as DraftWithManuscript
    const manuscript = draft.manuscripts
    const manuscriptText = draft.parsed_text || ''
    const persona = (session.reviewer_persona as ReviewerPersona) || 'social_science_quant'
    const field = manuscript.field || 'this field'

    const review = await runDeepReviewer(
      manuscriptText,
      persona,
      field,
      manuscript.submission_target
    )

    const scoreRows = review.scores.map(s => ({
      session_id: sessionId,
      dimension: s.dimension,
      score: s.score,
      max_score: 10,
      rationale: s.rationale,
      improvements: s.improvements,
    }))
    await mustWrite('insert scores', supabase.from('scores').insert(scoreRows), {
      sessionId,
      rowCount: scoreRows.length,
    })

    const annotationRows = review.annotations.map(a => ({
      session_id: sessionId,
      section: a.section,
      severity: a.severity,
      comment: a.comment,
      suggestion: a.suggestion,
    }))
    if (annotationRows.length > 0) {
      await mustWrite('insert annotations', supabase.from('annotations').insert(annotationRows), {
        sessionId,
        rowCount: annotationRows.length,
      })
    }

    await mustWrite(
      'persist review result',
      supabase.from('review_sessions').update({
        overall_score: review.overall_score,
        verdict: review.verdict,
        strength_summary: review.strength_summary,
        weakness_summary: review.weakness_summary,
        status: 'complete',
        completed_at: new Date().toISOString(),
      }).eq('id', sessionId),
      { sessionId },
    )

    // The review exists and the user has it — spend the credit now, and charge
    // the manuscript's slot if this is its first completed review.
    //
    // Deliberately not wrapped in mustWrite: by this point the user already has
    // their review, so failing to charge under-bills rather than losing work.
    // That is the correct direction to fail; report it and carry on.
    try {
      const { windowStart } = await resolveQuotaContext(manuscript.user_id)
      await commitReviewCredit({
        sessionId,
        userId: manuscript.user_id,
        manuscriptId: manuscript.id,
        windowStart,
      })
    } catch (e) {
      reportError(e, { sessionId, stage: 'usage commit', manuscriptId: manuscript.id })
    }

    // Best-effort draft-to-draft comparison; never fails the (already saved)
    // review, so this reports as a warning rather than throwing.
    try {
      await runProgressComparison(sessionId, manuscript.id, draft.version_number)
    } catch (e) {
      reportWarning('progress comparison failed', {
        sessionId,
        manuscriptId: manuscript.id,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (!isReported(err)) reportError(err, { sessionId, stage: 'deep review' })
    // Deliberately NOT wrapped — see the note in runReviewPipeline's catch.
    await supabase.from('review_sessions').update({
      status: 'failed',
      error_message: message,
    }).eq('id', sessionId)
    // A review that produced nothing must not be charged.
    await releaseReviewCredit(sessionId)
    throw err
  } finally {
    await flushMonitoring()
  }
}

/**
 * If an earlier draft of the same manuscript has a completed review, compare it
 * to this session and store the result in score_delta. Powers the Progress tab (#2).
 */
async function runProgressComparison(
  sessionId: string,
  manuscriptId: string,
  currentVersion?: number
) {
  if (typeof currentVersion !== 'number') return
  const supabase = createAdminClient()

  const { data: priorDrafts } = await supabase
    .from('drafts')
    .select('id')
    .eq('manuscript_id', manuscriptId)
    .lt('version_number', currentVersion)
    .order('version_number', { ascending: false })
    .limit(1)
  const priorDraftId = priorDrafts?.[0]?.id
  if (!priorDraftId) return

  const { data: priorSessions } = await supabase
    .from('review_sessions')
    .select('id, scores(*), annotations(*)')
    .eq('draft_id', priorDraftId)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
  const prior = priorSessions?.[0]
  if (!prior) return

  const { data: currentScores } = await supabase
    .from('scores')
    .select('*')
    .eq('session_id', sessionId)

  const result = await runProgressComparator({
    v1Scores: (prior.scores as Score[]) ?? [],
    v2Scores: (currentScores as Score[]) ?? [],
    v1Annotations: (prior.annotations as Annotation[]) ?? [],
  })

  await supabase.from('review_sessions')
    .update({ score_delta: result, compared_to_session_id: prior.id })
    .eq('id', sessionId)
}
