import { anthropic, MODEL, MAX_TOKENS } from '../anthropic'
import { extractJson } from '../json'
import { textFromResponse } from '../response'
import type { ReportingGuideline } from '@/lib/reporting/guidelines'
import type { ReportingCheckerResult } from '@/lib/types'

const SYSTEM_PROMPT = `You are an expert journal editor checking whether a manuscript satisfies a specific reporting-guideline checklist.

You will be given the manuscript text and a numbered checklist. For EVERY checklist item, decide one status:
- "present": the manuscript clearly and fully addresses the item.
- "partial": the item is addressed but incompletely or ambiguously.
- "missing": the item is not addressed.
- "not_applicable": the item does not apply to this study (use sparingly, only when clearly inapplicable).

For each item provide brief "evidence" (a short quote or the section where it is addressed; empty string if missing) and a concrete "fix" (what the author should add or change; empty string if already present).

Return ONLY valid JSON matching this exact shape:
{
  "summary": string,                 // 1-2 sentences on overall reporting completeness
  "items": [
    {
      "code": string,                // must match a checklist item code exactly
      "status": "present" | "partial" | "missing" | "not_applicable",
      "evidence": string,
      "fix": string
    }
  ]
}

Include one entry for every checklist item. Do not invent items beyond the checklist.`

export interface ReportingCheckParams {
  manuscriptText: string
  guideline: ReportingGuideline
}

/** Pure, testable: assembles the user prompt from the manuscript + canonical items. */
export function buildReportingContext(p: ReportingCheckParams): string {
  const items = p.guideline.items
    .map(i => `- [${i.code}] (${i.section}) ${i.requirement}`)
    .join('\n')
  return [
    `Reporting guideline: ${p.guideline.name}`,
    `Applies to: ${p.guideline.applicableTo}`,
    '',
    'Checklist items:',
    items,
    '',
    'Manuscript text:',
    p.manuscriptText,
  ].join('\n')
}

export async function runReportingChecker(
  params: ReportingCheckParams
): Promise<ReportingCheckerResult> {
  const userPrompt = buildReportingContext(params)

  const call = async () => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const text = textFromResponse(response)
    return extractJson<ReportingCheckerResult>(text)
  }
  try {
    return await call()
  } catch {
    return await call() // one retry on malformed JSON
  }
}
