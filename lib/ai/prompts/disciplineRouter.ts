import { anthropic, MODEL } from '../anthropic'
import { extractJson } from '../json'
import { textFromResponse } from '../response'
import type { DisciplineRouterResult } from '@/lib/types'

const SYSTEM = `You are an expert academic librarian and meta-reviewer. Your only job is to analyse a manuscript and return a JSON object identifying its discipline, sub-field, document type, and the most appropriate reviewer persona to apply.

Reviewer personas available:
- "biomedical_rct" — randomised controlled trials, clinical medicine
- "social_science_quant" — quantitative social science, survey research
- "social_science_qual" — qualitative, ethnographic, grounded theory
- "cs_systems" — systems papers, benchmarks, implementation
- "cs_ml_theory" — ML/AI, theoretical contributions
- "economics_theory" — formal models, proofs, working papers
- "humanities_interpretive" — history, literary studies, philosophy
- "environmental_science" — ecology, climate, field studies
- "engineering_applied" — applied engineering, design papers
- "education_research" — pedagogy, curriculum, mixed-methods

Return ONLY valid JSON, no preamble, no markdown fences:
{
  "field": string,
  "subfield": string,
  "doc_type": "journal_article" | "thesis_chapter" | "conference_paper" | "grant_proposal" | "systematic_review",
  "persona": string,
  "confidence": number between 0 and 1,
  "reasoning": string max 40 words
}`

export async function runDisciplineRouter(
  title: string,
  abstract: string
): Promise<DisciplineRouterResult> {
  const call = async () => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Title: ${title}\n\nAbstract: ${abstract}` }],
    })
    const text = textFromResponse(response)
    return extractJson<DisciplineRouterResult>(text)
  }
  try {
    return await call()
  } catch {
    return await call() // one retry on malformed JSON
  }
}
