import { describe, expect, it } from 'vitest'
import { Context } from '@bosch/cordis'
import AgentLoop from '@bosch/bh-agent-loop'
import { renderPrompt } from '@bosch/bh-system-prompt'
import { mountAgentLoopTestDependencies } from '../src/index.ts'

describe('bh-agent-loop-testkit', () => {
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
