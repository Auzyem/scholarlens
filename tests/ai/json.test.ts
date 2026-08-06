import { describe, it, expect } from 'vitest'
import { extractJson } from '@/lib/ai/json'

describe('extractJson', () => {
  it('parses clean JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('strips markdown fences', () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 })
  })
  it('throws on unparseable text', () => {
    expect(() => extractJson('not json')).toThrow()
  })
  it('recovers JSON wrapped in prose', () => {
    expect(extractJson('Here you go:\n{"a":3}\nHope that helps.')).toEqual({ a: 3 })
  })
  it('says the response looks incomplete rather than leaking a raw syntax error', () => {
    // Salvaging a response cut off mid-array slices to the last '}', which is
    // still unterminated — the bare V8 message ("Expected ',' or ']' after
    // array element") reached the user with no hint of the real cause.
    const truncated = '{\n  "annotations": [\n    { "a": 1 },\n    { "a": 2 },\n    { "a"'
    expect(() => extractJson(truncated)).toThrow(/incomplete/i)
  })
})
