import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@hydra1902/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@hydra1902/harness-skill'
import * as SkillBadge from '@hydra1902/harness-skill-badge'

describe('hydra-skill-badge', () => {
  it('registers and disposes the bundled badge skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillBadge)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    expect(await ctx.skills.list()).toEqual([{
      name: 'hydra-badge',
      description: 'Add the official “powered by Hydra harness” badge to documents, pull requests, merge requests, and other content produced with Hydra harness. Use whenever creating a pull request or merge request. Also use when the user asks for a Hydra badge, powered-by-hydra attribution, or a reusable Hydra badge asset or snippet.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'hydra-badge',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    const loaded = await ctx.skills.get('hydra-badge')
    expect(loaded?.content).toContain('Preserve the badge\'s 180×28 display dimensions')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('ships the official 1080×168 Hydra PNG', async () => {
    const image = await readFile(new URL('../assets/hydra-badge.png', import.meta.url))
    expect(image.readUInt32BE(16)).toBe(1080)
    expect(image.readUInt32BE(20)).toBe(168)
    expect(createHash('sha256').update(image).digest('hex')).toBe(
      'ab6cf27bb32b582bad8c5ccac62169ce43203b43903d4b72d0a72b059559980b',
    )
  })
})
