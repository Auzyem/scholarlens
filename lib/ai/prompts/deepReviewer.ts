import { anthropic, MODEL, MAX_TOKENS } from '../anthropic'
import { extractJson } from '../json'
import { textFromResponse } from '../response'
import type { DeepReviewerResult, ReviewerPersona } from '@/lib/types'

const SYSTEM = (persona: ReviewerPersona, target: string) =>
  `You are a senior peer reviewer for ${target} acting as a ${persona.replace(/_/g, ' ')} specialist. You have reviewed over 200 manuscripts in this field. You are rigorous, fair, and specific — you cite exact passages, not vague impressions.

Evaluate the manuscript across these 8 dimensions (score each 1–10):
1. originality — is the contribution genuinely new?
2. significance — does it matter to the field?
3. methodology — is the approach sound and appropriate?
4. evidence_quality — are claims supported by data?
5. literature_engagement — is prior work fairly represented?
6. internal_logic — is the argument coherent end-to-end?
7. presentation_clarity — is it readable and well-structured?
8. ethical_compliance — funding disclosure, conflicts, data availability

Return ONLY valid JSON with this exact shape:
{
  "scores": [
    { "dimension": string, "score": number 1-10, "rationale": string 2-3 sentences, "improvements": array of 1-3 specific actionable strings }
  ],
  "verdict": "accept" | "minor_revision" | "major_revision" | "reject",
  "overall_score": number sum of all 8 scores,
  "strength_summary": string max 30 words,
  "weakness_summary": string max 30 words,
  "annotations": [
    { "section": string, "severity": "critical" | "major" | "minor", "comment": string, "suggestion": string }
  ]
}

Return at most 12 annotations, most important first. Prefer a few substantive comments over many trivial ones.`

export async function runDeepReviewer(
  manuscriptText: string,
  persona: ReviewerPersona,
  field: string,
  journalTarget?: string
): Promise<DeepReviewerResult> {
  const target = journalTarget || 'a leading peer-reviewed journal in this field'
  const call = async () => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM(persona, target),
      messages: [{
        role: 'user',
        content: `Field: ${field}\nPersona: ${persona}\n\nManuscript:\n${manuscriptText.slice(0, 80000)}`,
      }],
    })
    const text = textFromResponse(response)
    return extractJson<DeepReviewerResult>(text)
  }
  try {
    return await call()
  } catch {
    return await call()
  }
}
