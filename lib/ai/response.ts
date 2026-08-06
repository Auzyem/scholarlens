// Structural shape of an Anthropic messages response — narrow enough that the
// SDK's Message satisfies it, loose enough to construct in tests.
export interface ModelResponse {
  stop_reason?: string | null
  content: Array<{ type: string }>
  usage?: { output_tokens?: number }
}

/**
 * Pull the text out of a model response, refusing anything the model did not
 * finish writing.
 *
 * A response that hits `max_tokens` stops mid-structure. Handing that to
 * `extractJson` produced a bare V8 parse error — users saw "Expected ',' or ']'
 * after array element in JSON at position 17474" on the review screen, which
 * points at the symptom and hides the cause.
 */
export function textFromResponse(response: ModelResponse): string {
  if (response.stop_reason === 'max_tokens') {
    const tokens = response.usage?.output_tokens
    throw new Error(
      `The reviewer's response was cut off at the output token limit${
        tokens ? ` (${tokens} tokens)` : ''
      }, so it is incomplete.`
    )
  }
  const block = response.content.find(b => b.type === 'text') as { text?: string } | undefined
  if (!block || typeof block.text !== 'string') {
    throw new Error('Model response contained no text')
  }
  return block.text
}
