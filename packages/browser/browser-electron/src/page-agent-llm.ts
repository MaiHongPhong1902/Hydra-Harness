/** Translate PageAgent's private OpenAI-shaped call into the owning Hydra model route. */

import { BlockAssembler, createMessage } from '@hydra/harness-llm'
import type { GenerateOptions, Message, ToolSchema } from '@hydra/harness-llm'
import type { Agent } from '@hydra/harness-agent'
import type { PageAgentLlmRequest } from './child.ts'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(text).join('\n')
  const object = record(value)
  if (typeof object?.text === 'string') return object.text
  return JSON.stringify(value ?? '')
}

function messagesOf(value: unknown): { system: string | undefined; messages: Message[] } {
  const system: string[] = []
  const messages: Message[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = record(raw)
    const content = text(entry?.content)
    if (entry?.role === 'system') {
      system.push(content)
      continue
    }
    messages.push(createMessage({
      role: entry?.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: content }],
      source: { kind: 'plugin', plugin: 'browser-page-agent' },
    }))
  }
  return { system: system.length === 0 ? undefined : system.join('\n\n'), messages }
}

function toolsOf(value: unknown): ToolSchema[] | undefined {
  const tools: ToolSchema[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    const fn = record(record(raw)?.function)
    if (record(raw)?.type !== 'function' || typeof fn?.name !== 'string' || typeof fn.description !== 'string') continue
    const parameters = record(fn.parameters)
    if (parameters === undefined) continue
    tools.push({ name: fn.name, description: fn.description, parameters })
  }
  return tools.length === 0 ? undefined : tools
}

/**
 * Run one PageAgent planning step through the owning Hydra model selection.
 * @param owner - agent whose provider, model, and model credentials are authoritative.
 * @param pageAgentRequest - opaque request emitted from the controlled preload.
 * @returns an OpenAI-compatible JSON response consumed only by upstream PageAgent.
 */
export async function executePageAgentLlm(owner: Agent, pageAgentRequest: PageAgentLlmRequest): Promise<JsonRecord> {
  const provider = owner.options.provider
  const model = owner.options.model
  if (provider === undefined || model === undefined) {
    throw new Error('PageAgent requires the owning Hydra agent to have a selected provider and model')
  }
  const input = record(pageAgentRequest.request)
  if (input === undefined) throw new Error('PageAgent sent an invalid model request')
  const { system, messages } = messagesOf(input.messages)
  if (messages.length === 0) throw new Error('PageAgent sent no model messages')
  const tools = toolsOf(input.tools)

  const request: GenerateOptions = {
    provider,
    model,
    messages,
    ...system === undefined ? {} : { system },
    ...tools === undefined ? {} : { tools },
  }
  const assembler = new BlockAssembler()
  for await (const chunk of owner.ctx.llm.stream(request)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)

  const blocks = assembler.blocks()
  const calls = blocks.filter(block => block.type === 'tool-call')
  const visible = blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: visible || null,
        ...calls.length === 0 ? {} : {
          tool_calls: calls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        },
      },
      finish_reason: calls.length === 0 ? 'stop' : 'tool_calls',
    }],
    usage: {
      prompt_tokens: assembler.usage?.inputTokens ?? 0,
      completion_tokens: assembler.usage?.outputTokens ?? 0,
      total_tokens: (assembler.usage?.inputTokens ?? 0) + (assembler.usage?.outputTokens ?? 0),
    },
  }
}
