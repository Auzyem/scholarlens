import Anthropic from '@anthropic-ai/sdk'

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export const MODEL = 'claude-sonnet-4-6'
// 4096 was not enough headroom: a dense manuscript produced enough annotations
// to hit the cap mid-array, and the truncated JSON failed the review. 16k is
// the recommended ceiling for non-streaming requests (large enough to finish,
// small enough to stay inside the SDK's HTTP timeout). Output is billed as
// generated, so the headroom only costs anything when it is actually used —
// the prompts cap their own list lengths to keep typical responses far below.
export const MAX_TOKENS = 16000
