import { anthropic, MODEL, MAX_TOKENS } from '../anthropic'
import { extractJson } from '../json'
import { textFromResponse } from '../response'
import type { AdversarialReviewerResult, ReviewerPersona, Score } from '@/lib/types'

// Pure helper: assemble a compact summary of the standard review's findings to
// ground the adversarial pass. Exported for unit testing.
export function buildPriorReviewContext(scores: Score[], weaknessSummary?: string): string {
  const lines: string[] = []
  if (weaknessSummary && weaknessSummary.trim()) {
    lines.push(`Prior reviewer's weakness summary: ${weaknessSummary.trim()}`)
  }
  const weakest = [...scores].sort((a, b) => a.score - b.score).slice(0, 3)
  if (weakest.length > 0) {
    lines.push('Lowest-scoring dimensions from the standard review:')
    for (const s of weakest) {
      const rationale = s.rationale?.trim() || 'no rationale given'
      lines.push(`- ${s.dimension} (${s.score}/${s.max_score}): ${rationale}`)
    }
  }
  if (lines.length === 0) {
    return 'No prior review findings are available; review the manuscript independently.'
  }
  return lines.join('\n')
}

const SYSTEM = (persona: ReviewerPersona, field: string) =>
  `You are the harshest credible peer reviewer ("Reviewer 2") for ${field}, acting as a ${persona.replace(/_/g, ' ')} specialist with 200+ reviews behind you. A polite reviewer has already assessed this manuscript. Your job is NOT to repeat their points — it is to ESCALATE: surface the fatal flaws they softened or missed, and state the objections that would actually sink this paper in review.

Rules:
- Every critique must quote an exact passage from the manuscript.
- Every critique must give a concrete required fix, not a vague gesture.
- Be adversarial but fair: no fabricated weaknesses, no nitpicking typos as if fatal.
- Prefer a few devastating objections over many trivial ones.

Return ONLY valid JSON with this exact shape, no preamble, no markdown fences:
{
  "summary": string max 40 words — the single biggest reason this paper would be rejected,
  "critiques": [
    {
      "severity": "critical" | "major" | "minor",
      "title": string short label,
      "quoted_passage": string exact quote from the manuscript,
      "objection": string 2-4 sentences,
      "required_fix": string concrete action,
      "section_reference": string section name or location
    }
  ]
}`

export async function runAdversarialReviewer(
  manuscriptText: string,
  persona: ReviewerPersona,
  field: string,
  priorReviewContext: string
): Promise<AdversarialReviewerResult> {
  const call = async () => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM(persona, field),
      messages: [{
        role: 'user',
        content: `Field: ${field}\nPersona: ${persona}\n\nStandard review findings to escalate:\n${priorReviewContext}\n\nManuscript:\n${manuscriptText.slice(0, 80000)}`,
      }],
    })
    const text = textFromResponse(response)
    return extractJson<AdversarialReviewerResult>(text)
  }
  try {
    return await call()
  } catch {
    return await call() // one retry on malformed JSON
  }
}
