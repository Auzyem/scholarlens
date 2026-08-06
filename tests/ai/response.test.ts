import { describe, it, expect } from 'vitest'
import { textFromResponse } from '@/lib/ai/response'

const message = (over: Record<string, unknown> = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"a":1}' }],
  usage: { output_tokens: 12 },
  ...over,
})

describe('textFromResponse', () => {
  it('returns the text block', () => {
    expect(textFromResponse(message())).toBe('{"a":1}')
  })

  it('names truncation when the model hit the output token limit', () => {
    // Regression: a max_tokens-truncated deep review reached extractJson and
    // surfaced to the user as "Expected ',' or ']' after array element in JSON
    // at position 17474", which says nothing about the actual cause.
    expect(() =>
      textFromResponse(
        message({
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: '{"annotations":[{"a":1},{"a":2}' }],
          usage: { output_tokens: 4096 },
        })
      )
    ).toThrow(/cut off|token limit/i)
  })

  it('reports the token count it was cut off at', () => {
    expect(() =>
      textFromResponse(message({ stop_reason: 'max_tokens', usage: { output_tokens: 4096 } }))
    ).toThrow(/4096/)
  })

  it('throws when the response carries no text block', () => {
    expect(() => textFromResponse(message({ content: [] }))).toThrow()
  })

  it('finds the text block when it is not first', () => {
    expect(
      textFromResponse(
        message({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'ok' }] })
      )
    ).toBe('ok')
  })
})
