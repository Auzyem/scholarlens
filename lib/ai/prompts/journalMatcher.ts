import { anthropic, MODEL, MAX_TOKENS } from '../anthropic'
import { extractJson } from '../json'
import { textFromResponse } from '../response'
import type { JournalMatchResult } from '@/lib/types'

const SYSTEM_PROMPT = `You are an expert in academic publishing strategy with deep, current knowledge of journal scope, prestige, impact factors, acceptance culture, and decision timelines across disciplines.

Given a manuscript's metadata and the result of a rigorous internal review, recommend the journals this author should realistically target. Balance prestige against acceptance probability — do not only suggest unreachable top venues, and do not only suggest easy ones. Tailor ambition to the author's career stage and the review score.

Return ONLY valid JSON matching this exact shape:
{
  "journals": [
    {
      "rank": number,                    // 1 = best overall recommendation
      "journal_name": string,
      "publisher": string,
      "fit_score": number,               // 0..1, how well the manuscript fits this venue
      "acceptance_band": "high" | "medium" | "low",  // likelihood of acceptance for THIS manuscript
      "impact_factor_range": string,     // e.g. "4.2-5.8" or "n/a"
      "avg_decision_days": number,       // typical first-decision time in days
      "key_change_required": string,     // the single most important change to be competitive here
      "open_access_options": string,     // e.g. "Gold OA available", "Hybrid", "Subscription only"
      "apc_cost": string,                // e.g. "$2,500 APC" or "No APC"
      "rationale": string                // 1-2 sentences on why this venue fits
    }
  ]
}

Return 5-8 journals ordered by rank (best fit first). Be realistic and specific with real journal names.`

export interface JournalMatchContextParams {
  title: string
  field: string
  subfield?: string
  docType?: string
  overallScore?: number
  strengthSummary?: string
  weaknessSummary?: string
  careerStage?: string
}

/**
 * Builds the user-prompt context for the journal matcher. Pure and testable —
 * the pipeline gathers these values from the DB and passes them in.
 */
export function buildJournalMatchContext(p: JournalMatchContextParams): string {
  const lines: string[] = [`Title: ${p.title}`, `Field: ${p.field}`]
  if (p.subfield) lines.push(`Subfield: ${p.subfield}`)
  if (p.docType) lines.push(`Document type: ${p.docType}`)
  if (typeof p.overallScore === 'number') lines.push(`Overall review score: ${p.overallScore}/80`)
  if (p.strengthSummary) lines.push(`Strengths: ${p.strengthSummary}`)
  if (p.weaknessSummary) lines.push(`Weaknesses: ${p.weaknessSummary}`)
  if (p.careerStage) lines.push(`Author career stage: ${p.careerStage}`)
  return lines.join('\n')
}

export async function runJournalMatcher(
  params: JournalMatchContextParams
): Promise<JournalMatchResult> {
  const userPrompt = buildJournalMatchContext(params)

  const call = async () => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const text = textFromResponse(response)
    return extractJson<JournalMatchResult>(text)
  }
  try {
    return await call()
  } catch {
    return await call() // one retry on malformed JSON
  }
}
