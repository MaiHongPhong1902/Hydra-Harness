import { describe, expect, it } from 'vitest'
import { Context } from '@hydra/cordis'
import AgentLoop from '@hydra/harness-agent-loop'
import { renderPrompt } from '@hydra/harness-system-prompt'
import { mountAgentLoopTestDependencies } from '../src/index.ts'

describe('hydra-agent-loop-testkit', () => {
  it('mounts a configurable prerequisite spine that can activate AgentLoop', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { persona: 'Test persona.' },
      tools: { mode: 'native' },
    })

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Test persona.')
    await expect(ctx.plugin(AgentLoop, { agents: [] })).resolves.toBeDefined()

    await ctx.fiber.dispose()
  })
})
