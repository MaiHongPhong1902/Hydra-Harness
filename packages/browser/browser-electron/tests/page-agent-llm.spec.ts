import { describe, expect, it } from 'vitest'
import type { Agent } from '@bosch/bh-agent'
import type { GenerateOptions, StreamChunk } from '@bosch/bh-llm'
import { executePageAgentLlm } from '../src/page-agent-llm.ts'

describe('executePageAgentLlm', () => {
  it('uses the owning BH route and returns PageAgent’s expected tool call shape', async () => {
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
