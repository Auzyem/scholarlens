// Parse a model text response into JSON, tolerating markdown fences and
// leading/trailing prose. Throws if no JSON object can be recovered.
export function extractJson<T = unknown>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch (first) {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T
      } catch {
        // Slicing to the last '}' salvages JSON buried in prose, but not a
        // response that stopped mid-array — the slice still ends inside an
        // unterminated structure. Say so, rather than surfacing the raw parser
        // message, which reads as gibberish to the user seeing it on screen.
        throw new Error(
          `Model response is not valid JSON and looks incomplete: ${(first as Error).message}`
        )
      }
    }
    throw new Error('No parseable JSON found in model response')
  }
}
