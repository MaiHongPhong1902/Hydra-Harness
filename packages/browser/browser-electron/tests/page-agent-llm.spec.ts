import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@hydra1902/harness-agent'
import type { GenerateOptions, StreamChunk } from '@hydra1902/harness-llm'
import { executePageAgentLlm } from '../src/page-agent-llm.ts'

describe('executePageAgentLlm', () => {
  function model(chunks: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]) {
    const stream = vi.fn(async function* (_request: GenerateOptions): AsyncGenerator<StreamChunk> {
      yield* chunks
    })
    const owner = { options: { provider: 'current-provider', model: 'current-model' }, ctx: { llm: { stream } } } as unknown as Agent
    return { owner, stream }
  }

  it.each([{}, { provider: 'current-provider' }, { model: 'current-model' }])('requires a complete selected route: %j', async (options) => {
    const { owner, stream } = model()
    await expect(executePageAgentLlm({ ...owner, options }, { tabId: 1, request: {} }))
      .rejects.toThrow('selected provider and model')
    expect(stream).not.toHaveBeenCalled()
  })

  it.each([null, [], 'request'])('rejects invalid wire requests: %j', async (request) => {
    const { owner, stream } = model()
    await expect(executePageAgentLlm(owner, { tabId: 1, request })).rejects.toThrow('invalid model request')
    expect(stream).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, [], [{ role: 'system', content: 'Only system' }]])('requires conversational messages: %j', async (messages) => {
    const { owner, stream } = model()
    await expect(executePageAgentLlm(owner, { tabId: 1, request: { messages } })).rejects.toThrow('no model messages')
    expect(stream).not.toHaveBeenCalled()
  })

  it('translates array content, assistant messages, and optional tools without exposing reasoning', async () => {
    const { owner, stream } = model([
      { type: 'reasoning-delta', index: 0, text: 'Private reasoning' },
      { type: 'text-delta', index: 1, text: 'Visible ' },
      { type: 'text-delta', index: 2, text: 'answer' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const response = await executePageAgentLlm(owner, {
      tabId: 1,
      request: {
        messages: [
          { role: 'system', content: 'First' }, { role: 'system', content: 'Second' },
          { role: 'user', content: ['plain', { text: 'block' }, { data: 1 }, null] },
          { role: 'assistant', content: 'Earlier answer' },
          null,
        ],
        tools: [null, { type: 'custom' }, { type: 'function' },
          { type: 'function', function: { name: 'missing-description' } },
          { type: 'function', function: { name: 'missing-parameters', description: 'missing' } }],
      },
    })
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      system: 'First\n\nSecond',
      messages: [
        expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'plain\nblock\n{"data":1}\n""' }] }),
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] }),
        expect.objectContaining({ role: 'user', content: [{ type: 'text', text: '""' }] }),
      ],
    }))
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('tools')
    expect(response).toEqual({
      choices: [{ message: { role: 'assistant', content: 'Visible answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    })
  })

  it('omits absent system and tools and reports zero usage when none arrives', async () => {
    const { owner, stream } = model()
    const response = await executePageAgentLlm(owner, { tabId: 1, request: { messages: [{ role: 'user', content: 'Continue' }] } })
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('system')
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('tools')
    expect(response).toEqual({
      choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  })

  it.each(['error', 'aborted'] as const)('propagates provider %s without a successful response', async (kind) => {
    const { owner } = model([{ type: 'finish', reason: { kind, failure: { message: 'Provider stopped', code: 'UNKNOWN' } } }])
    await expect(executePageAgentLlm(owner, { tabId: 1, request: { messages: [{ role: 'user', content: 'Continue' }] } }))
      .rejects.toThrow('Provider stopped')
  })

  it('uses the owning Hydra route and returns PageAgent’s expected tool call shape', async () => {
    let sent: GenerateOptions | undefined
    const owner = {
      options: { provider: 'current-provider', model: 'current-model' },
      ctx: {
        llm: {
          stream: async function* (request: GenerateOptions): AsyncGenerator<StreamChunk> {
            sent = request
            yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'AgentOutput', argumentsDelta: '{"action":{}}' } as StreamChunk
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          },
        },
      },
    } as unknown as Agent

    const response = await executePageAgentLlm(owner, {
      tabId: 1,
      request: {
        messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Do it' }],
        tools: [{ type: 'function', function: { name: 'AgentOutput', description: 'output', parameters: { type: 'object' } } }],
      },
    })

    expect(sent).toMatchObject({
      provider: 'current-provider',
      model: 'current-model',
      system: 'System',
      tools: [{ name: 'AgentOutput' }],
    })
    expect(response.choices).toEqual([{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'AgentOutput', arguments: '{"action":{}}' } }],
      },
      finish_reason: 'tool_calls',
    }])
  })
})
