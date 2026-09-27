import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type {} from '@hydra1902/harness-skill'
import { SessionId } from '@hydra1902/harness-session'
import type {} from '@hydra1902/harness-agent-presets'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

async function writeSkill(root: string, name: string): Promise<void> {
  const bundle = join(root, name)
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), `---
name: ${name}
description: Must not enter the Web replay scaffold
---

Ambient host state.
`)
}

it('isolates replay skill discovery from every ambient host root', async () => {
  const ambient = await mkdtemp(join(tmpdir(), 'hydra-web-ambient-skills-'))
  const hydraHome = join(ambient, 'hydra-home')
  const agentsHome = join(ambient, 'agents-home')
  const bundled = join(ambient, 'bundled')
  await Promise.all([
    writeSkill(join(hydraHome, 'skills'), 'ambient-hydra'),
    writeSkill(join(agentsHome, 'skills'), 'ambient-agents'),
    writeSkill(bundled, 'ambient-bundled'),
  ])

  const originalHydraHome = process.env.HYDRA_HOME
  const originalAgentsHome = process.env.HYDRA_AGENTS_HOME
  const originalBundled = process.env.HYDRA_BUNDLED_SKILL_DIR
  process.env.HYDRA_HOME = hydraHome
  process.env.HYDRA_AGENTS_HOME = agentsHome
  process.env.HYDRA_BUNDLED_SKILL_DIR = bundled
  let scaffold: WebScaffold | undefined
  try {
    scaffold = await launchWebScaffold()
    const ctx = scaffold.ctx
    // Local skill discovery belongs to the agent's preset LAYER of the host
    // registry, so the roots under test are only reachable through a composed
    // agent's view — the same scope the gateway's `skill.list` resolves for a
    // browser request about a session.
    const handle = await ctx.agents.create({
      sessionId: SessionId('hermetic-skills'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      const skills = ctx.get('skills')
      if (skills === undefined) throw new Error('the composition mounts no skill registry')
      const names = (await skills.list({ cwd: scaffold.workspaceCwd, scope: handle.agent })).map(skill => skill.name)
      expect(names).not.toContain('ambient-hydra')
      expect(names).not.toContain('ambient-agents')
      expect(names).not.toContain('ambient-bundled')
    } finally {
      await handle.dispose()
    }
  } finally {
    try {
      await scaffold?.close()
    } finally {
      if (originalHydraHome === undefined) delete process.env.HYDRA_HOME
      else process.env.HYDRA_HOME = originalHydraHome
      if (originalAgentsHome === undefined) delete process.env.HYDRA_AGENTS_HOME
      else process.env.HYDRA_AGENTS_HOME = originalAgentsHome
      if (originalBundled === undefined) delete process.env.HYDRA_BUNDLED_SKILL_DIR
      else process.env.HYDRA_BUNDLED_SKILL_DIR = originalBundled
      await rm(ambient, { recursive: true, force: true })
    }
  }
})
