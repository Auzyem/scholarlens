import { anthropic, MODEL, MAX_TOKENS } from '../anthropic'
import { extractJson } from '../json'
import { textFromResponse } from '../response'
import type { ProgressComparatorResult, Score, Annotation, ScoreDimension } from '@/lib/types'

const SYSTEM = `You are a manuscript improvement analyst comparing two drafts of the same paper. You are given the per-dimension scores for the previous version (v1) and the current version (v2), plus the reviewer comments raised on v1. Assess honestly whether the revision actually improved the manuscript and whether the v1 comments were addressed.

Return ONLY valid JSON with this exact shape, no preamble, no markdown fences:
{
  "dimension_changes": [
    {
      "dimension": string,
      "v1_score": number,
      "v2_score": number,
      "delta": number,
      "direction": "improved" | "regressed" | "unchanged",
      "cause": string optional — what revision likely caused this,
      "comment_addressed": "fully" | "partially" | "not_addressed"
    }
  ],
  "overall_summary": string 2-3 sentences, honest,
  "top_improvements": array of up to 3 strings,
  "remaining_issues": array of up to 3 strings,
  "readiness": "not_ready" | "minor_fixes" | "submission_ready",
  "recommended_action": string one sentence,
  "new_problems_introduced": array of strings — any NEW issues in v2
}`

export interface ProgressContextParams {
  v1Scores: Score[]
  v2Scores: Score[]
  v1Annotations: Annotation[]
}

/**
 * Pure, testable: assemble a compact v1→v2 diff plus the prior reviewer comments
 * the author was expected to address.
 */
export function buildProgressContext(p: ProgressContextParams): string {
  const v1 = new Map(p.v1Scores.map(s => [s.dimension, s.score]))
  const v2 = new Map(p.v2Scores.map(s => [s.dimension, s.score]))
  // Ordered unique dimensions across both versions (avoid spreading Map iterators,
  // which needs a higher TS target than next build uses).
  const dims: ScoreDimension[] = []
  const seen = new Set<string>()
  for (const s of p.v1Scores.concat(p.v2Scores)) {
    if (!seen.has(s.dimension)) {
      seen.add(s.dimension)
      dims.push(s.dimension)
    }
  }

  const lines: string[] = ['Score changes (v1 -> v2):']
  for (const d of dims) {
    lines.push(`- ${d}: ${v1.get(d) ?? 'n/a'} -> ${v2.get(d) ?? 'n/a'}`)
  }
  if (p.v1Annotations.length > 0) {
    lines.push('', 'Reviewer comments on the previous version (judge whether v2 addresses each):')
    for (const a of p.v1Annotations) {
      lines.push(`- [${a.severity}] ${a.comment}`)
    }
  }
  return lines.join('\n')
}

export async function runProgressComparator(
  params: ProgressContextParams
): Promise<ProgressComparatorResult> {
  const userPrompt = buildProgressContext(params)
  const call = async () => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const text = textFromResponse(response)
    return extractJson<ProgressComparatorResult>(text)
  }
  try {
    return await call()
  } catch {
    return await call() // one retry on malformed JSON
  }
}
