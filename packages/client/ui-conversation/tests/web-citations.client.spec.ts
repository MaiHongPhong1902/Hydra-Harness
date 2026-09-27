import { describe, expect, it } from 'vitest'
import type { ToolResultNode } from '@hydra1902/harness-client-runtime/client'
import { webCitations } from '../src/client/chat/web-citations.ts'

describe('recorded web citations', () => {
  const id = 'a'.repeat(64)
  const source: ToolResultNode = { kind: 'tool-result', seq: 4, time: 1, callId: 'fetch', callTime: 0,
    call: { name: 'web_fetch', argsRaw: '{}' }, isError: false, callView: null, resultView: null, subCalls: [],
    content: [{ type: 'text', text: `Fetched https://example.com (HTTP 200)\nSource: ${id}\n\nHello world.` }] }
  it('resolves exact quotes and offsets only from preceding successful sources', () => {
    const resolver = webCitations([source], 5)
    expect(resolver.resolve(id, 'world')).toEqual({ url: 'https://example.com', start: 6, end: 11 })
    expect(resolver.resolve(id, 'invented')).toBeUndefined()
    expect(resolver.resolve(id, '')).toBeUndefined()
    expect(resolver.resolve('missing', 'Hello')).toBeUndefined()
    expect(webCitations([source], 3).resolve(id, 'Hello')).toBeUndefined()
    expect(webCitations([{ ...source, isError: true }], 5).resolve(id, 'Hello')).toBeUndefined()
  })
  it('accepts a recorded fetch nested in Code Mode', () => {
    const outer: ToolResultNode = { ...source, seq: 6, call: { name: 'run_code', argsRaw: '{}' }, content: [], subCalls: [source] }
    expect(webCitations([outer], 7).resolve(id, 'world')?.start).toBe(6)
  })
})
