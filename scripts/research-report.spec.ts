import { describe, expect, it } from 'vitest'
import { researchReport } from './research-report.ts'

describe('research report', () => {
  it('excludes inherited work, pairs nested calls, and counts usage once', () => {
    const rows = [
      { type: 'session', seedLength: 4 },
      { type: 'text-chunks', data: { texts: ['old', ' ', 'answer'] } },
      { type: 'assistant/message', data: { usage: { outputTokens: 999 } } },
      { type: 'step/start', data: {} },
      { type: 'tool/code-dispatch-start', time: 100, data: { subCallId: 'a', name: 'web_fetch' } },
      { type: 'tool/code-dispatch', time: 140, data: { subCallId: 'a', name: 'web_fetch', content: [{ text: 'hello' }], isError: false } },
      { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { outputTokens: 4 } } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 4 } } },
    ]
    expect(researchReport(rows.map(row => JSON.stringify(row)).join('\n'))).toEqual({
      tools: [{ name: 'web_fetch', durationMs: 40, outputChars: 5, error: false }], modelRequests: 1, inputTokens: 10, outputTokens: 4, cacheReadTokens: 0,
    })
    expect(() => researchReport('null')).toThrow('row must be an object')
  })

  it('reads native tool result envelopes and preserves unavailable timing', () => {
    const rows = [
      { type: 'session' },
      { type: 'tool/call', data: { callId: 'fetch', name: 'web_fetch' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'fetch' }, content: [
        { type: 'tool-result', isError: true, content: [{ type: 'text', text: 'blocked' }] },
      ] } } },
    ]
    expect(researchReport(rows.map(row => JSON.stringify(row)).join('\n')).tools)
      .toEqual([{ name: 'web_fetch', durationMs: null, outputChars: 7, error: true }])
  })
})
