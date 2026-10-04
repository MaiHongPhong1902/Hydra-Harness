/** Output-cap omission and explicit budgets through the installed pi-ai HTTP clients. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import LlmRuntime, { createUserMessage } from '@hydraharness/harness-llm'
import * as LlmPiAi from '@hydraharness/harness-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

beforeEach(() => { vi.stubEnv('PI_OUTPUT_TEST_KEY', 'fixture-key') })
afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

it.each(['max_tokens', 'max_completion_tokens'] as const)(
  'omits %s for an unsized model and preserves explicit request and model caps',
  async (field) => {
    const server = await mockServer(Array.from({ length: 3 }, () => ({ events: textEvents })))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, { providers: { gateway: {
        apiKeyEnv: 'PI_OUTPUT_TEST_KEY', api: 'openai-completions', baseURL: `${server.url}/v1`,
        compat: { maxTokensField: field },
        models: [{ id: 'unsized' }, { id: 'capped', maxTokens: 1024 }],
      } } })
      for (const config of [{ model: 'unsized' }, { model: 'unsized', maxTokens: 512 }, { model: 'capped' }]) {
        const result = await assemble(ctx, { provider: 'gateway', messages: [], ...config })
        expect(result.finish).toEqual({ kind: 'stop' })
      }
      expect(server.requests[0]).not.toHaveProperty('max_tokens')
      expect(server.requests[0]).not.toHaveProperty('max_completion_tokens')
      expect(server.requests[1]).toHaveProperty(field, 512)
      expect(server.requests[2]).toHaveProperty(field, 1024)
    } finally {
      await ctx.fiber.dispose()
    }
  },
)

it.each(['openai-responses', 'google-generative-ai', 'anthropic-messages'] as const)(
  'respects the %s output-cap requirements',
  async (api) => {
    const server = await mockServer(Array.from({ length: 2 }, () => ({ status: 401, body: '{"error":{"message":"fixture"}}' })))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, { providers: { gateway: {
        apiKeyEnv: 'PI_OUTPUT_TEST_KEY', api, baseURL: `${server.url}/v1`, models: [{ id: 'unsized' }],
      } } })
      // Authentication failures let all three real serializers reach HTTP without protocol-specific response fixtures.
      for (const cap of [undefined, 512]) {
        const result = await assemble(ctx, {
          provider: 'gateway', model: 'unsized', messages: [createUserMessage({
            content: [{ type: 'text', text: 'Hello' }], source: { kind: 'plugin', plugin: 'test' },
          })],
          ...cap === undefined ? {} : { maxTokens: cap },
        })
        expect(result.finish.kind).toBe('error')
      }
      expect(server.requests).toHaveLength(2)
      const field = api === 'openai-responses' ? 'max_output_tokens'
        : api === 'google-generative-ai' ? 'generationConfig.maxOutputTokens' : 'max_tokens'
      if (api === 'anthropic-messages') {
        expect(server.requests[0]).toHaveProperty(field)
        expect((server.requests[0] as { max_tokens: number }).max_tokens).toBeGreaterThan(16_384)
      } else {
        expect(server.requests[0]).not.toHaveProperty(field)
      }
      expect(server.requests[1]).toHaveProperty(field, 512)
    } finally {
      await ctx.fiber.dispose()
    }
  },
)
