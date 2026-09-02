import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@bosch/cordis'
import SystemPrompt from '@bosch/bh-system-prompt'
import SkillRegistry from '@bosch/bh-skill'
import CommandRuntime from '@bosch/bh-commands'
import ToolRuntime from '@bosch/bh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportedPluginRuntime, PluginManifestLoader, PluginStore } from '../src/index.ts'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execFileMock,
}))

const roots: string[] = []

async function temp(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `bh-plugin-runtime-${label}-`))
  roots.push(root)
  return root
}

async function plugin(root: string, version = '1.0.0', extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await mkdir(join(root, 'skills', 'hello'), { recursive: true })
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo-plugin', version, description: 'fixture', skills: './skills/', ...extra,
  }))
  await writeFile(join(root, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nHello.')
}

async function command(root: string, name: string, source: string): Promise<void> {
  await mkdir(join(root, 'commands'), { recursive: true })
  await writeFile(join(root, 'commands', `${name}.toml`), source)
}

async function runtime(home: string): Promise<{ ctx: Context; plugins: ImportedPluginRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ImportedPluginRuntime, { bhHome: home })
  return { ctx, plugins: ctx.importedPlugins }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  execFileMock.mockReset()
})

describe('PluginStore', () => {
  it('stages immutable source-qualified bundles and retains versions for rollback', async () => {
    const home = await temp('home')
    const source = await temp('source')
    await plugin(source)
    const store = new PluginStore(home)
    const identity = await store.install(source)
    expect(identity).toMatch(/^demo-plugin@[a-f0-9]{16}$/u)
    const first = await store.get(identity)
    expect(first?.activeVersion).toBe('1.0.0')
    const installedSkill = join(store.bundlePath(first!), 'skills', 'hello', 'SKILL.md')
    await writeFile(join(source, 'skills', 'hello', 'SKILL.md'), 'changed source')
    await expect(readFile(installedSkill, 'utf8')).resolves.toContain('Hello.')

    await plugin(source, '1.1.0')
    expect(await store.install(source)).toBe(identity)
    const upgraded = await store.get(identity)
    expect(upgraded?.activeVersion).toBe('1.1.0')
    expect(Object.keys(upgraded?.versions ?? {})).toEqual(['1.0.0', '1.1.0'])
  })

  it('normalizes MCP wrappers, keeps app metadata inert, and rejects cwd escapes', async () => {
    const root = await temp('mcp')
    await plugin(root, '1.0.0', { mcpServers: './mcp.json' })
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ ignored: { command: 'nope' } }))
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcp_servers: {
      local: { command: 'node', args: ['server.js'], cwd: './skills' },
    } }))
    await writeFile(join(root, '.app.json'), JSON.stringify({ apps: { remote: { id: 'example' } } }))
    const loaded = await new PluginManifestLoader().load(root, 'demo-plugin@source')
    expect(loaded.mcp.map(server => server.name)).toEqual(['local'])
    expect(loaded.apps).toEqual({ apps: { remote: { id: 'example' } } })

    await plugin(root, '1.0.1', { mcpServers: { local: { command: 'node', cwd: '../outside' } } })
    await expect(new PluginManifestLoader().load(root, 'demo-plugin@source')).rejects.toThrow('outside the plugin root')
  })

  it('accepts direct MCP maps and both documented compatibility wrappers', async () => {
    const root = await temp('mcp-maps')
    await plugin(root, '1.0.0', { mcpServers: './.mcp.json' })
    for (const [document, expected] of [
      [{ direct: { command: 'node' } }, 'direct'],
      [{ mcp_servers: { snake: { command: 'node' } } }, 'snake'],
      [{ mcpServers: { camel: { command: 'node' } } }, 'camel'],
    ] as const) {
      await writeFile(join(root, '.mcp.json'), JSON.stringify(document))
      const loaded = await new PluginManifestLoader().load(root, 'demo-plugin@source')
      expect(loaded.mcp.map(server => server.name)).toEqual([expected])
    }
  })

  it('reads standard marketplace entries and lets a manifest hook override the default file', async () => {
    const marketplace = await temp('marketplace')
    const pluginRoot = join(marketplace, 'plugins', 'demo-plugin')
    await plugin(pluginRoot, '1.0.0', { hooks: { Stop: [] } })
    await mkdir(join(pluginRoot, 'hooks'), { recursive: true })
    await writeFile(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }))
    await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'demo-marketplace',
      plugins: [{
        name: 'demo-plugin',
        source: { source: 'local', path: './plugins/demo-plugin/' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    }))

    const store = new PluginStore(await temp('home'))
    const identity = await store.install({ source: marketplace, plugin: 'demo-plugin' })
    const installed = await store.get(identity)
    expect(installed?.source.kind).toBe('marketplace-local')
    expect((await store.load(installed!, identity)).hooks.map(hook => hook.label)).toEqual(['manifest hooks 1'])
  })

  it('resolves a standard Git-subdirectory marketplace entry', async () => {
    const marketplace = await temp('git-marketplace')
    const repository = await temp('git-plugin-repository')
    await plugin(join(repository, 'plugins', 'demo-plugin'))
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      void cp(repository, String(args.at(-1)), { recursive: true }).then(
        () => callback(null, '', ''),
        error => callback(error, '', ''),
      )
    })
    await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'git-marketplace',
      plugins: [{
        id: 'demo-plugin',
        name: 'demo-plugin',
        source: { source: 'git-subdir', url: 'https://example.test/plugins.git', path: './plugins/demo-plugin', ref: 'main' },
      }],
    }))

    const store = new PluginStore(await temp('home'))
    const identity = await store.install({ source: marketplace, plugin: 'demo-plugin' })
    const installed = await store.get(identity)
    expect(installed?.source).toMatchObject({ kind: 'marketplace-local', source: marketplace, path: './plugins/demo-plugin', ref: 'main' })
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '--branch', 'main', '--', 'https://example.test/plugins.git']),
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('rejects traversal, Windows absolute paths, and symbolic-link escapes', async () => {
    const traversal = await temp('traversal')
    await plugin(traversal, '1.0.0', { skills: '../outside' })
    await expect(new PluginStore(await temp('home')).install(traversal)).rejects.toThrow('traverse')

    const absolute = await temp('absolute')
    await plugin(absolute, '1.0.0', { hooks: 'C:\\outside\\hooks.json' })
    await expect(new PluginStore(await temp('home')).install(absolute)).rejects.toThrow('relative')

    const interfaceEscape = await temp('interface-escape')
    await plugin(interfaceEscape, '1.0.0', { interface: { logo: '../outside.png' } })
    await expect(new PluginStore(await temp('home')).install(interfaceEscape)).rejects.toThrow('traverse')

    const linked = await temp('linked')
    await plugin(linked)
    try {
      await symlink(await temp('target'), join(linked, 'escape'), 'junction')
    } catch {
      // Windows without Developer Mode cannot create a link; the platform-independent
      // traversal checks above still run, while CI hosts with links exercise the guard.
      return
    }
    await expect(new PluginStore(await temp('home')).install(linked)).rejects.toThrow(/symbolic links|junction/u)
  })

  it('keeps duplicate names isolated by synthetic direct-import sources and changes hook digests', async () => {
    const left = await temp('left')
    const right = await temp('right')
    const home = await temp('home')
    await plugin(left, '1.0.0', { hooks: { UserPromptSubmit: [] } })
    await plugin(right, '1.0.0', { hooks: { Stop: [] } })
    const store = new PluginStore(home)
    const leftId = await store.install(left)
    const rightId = await store.install(right)
    expect(leftId).not.toBe(rightId)
    const before = await new PluginManifestLoader().load(left, leftId)
    await plugin(left, '1.0.1', { hooks: { Stop: [{ hooks: [{ command: 'echo changed' }] }] } })
    const after = await new PluginManifestLoader().load(left, leftId)
    expect(after.hookDigest).not.toBe(before.hookDigest)
  })

  it('removes enabled plugin skills and re-requires hook trust after an upgrade', async () => {
    const home = await temp('runtime-home')
    const source = await temp('runtime-source')
    await plugin(source, '1.0.0', { hooks: { Stop: [] } })
    const { ctx, plugins } = await runtime(home)
    const imported = await plugins.import(source)
    const identity = imported.plugins[0]!.identity
    expect(imported.plugins[0]!.hookTrustState).toBe('pending')

    await plugins.enable(identity)
    expect((await ctx.skills.list()).some(skill => skill.source === `codex-plugin:${identity}`)).toBe(true)
    await plugins.disable(identity)
    expect((await ctx.skills.list()).some(skill => skill.source === `codex-plugin:${identity}`)).toBe(false)

    expect((await plugins.trustHooks(identity)).plugins[0]!.hookTrustState).toBe('trusted')
    await plugin(source, '1.1.0', { hooks: { UserPromptSubmit: [] } })
    expect((await plugins.import(source)).plugins[0]!.hookTrustState).toBe('pending')
  })

  it('loads an installed plugin after its local source is removed', async () => {
    const home = await temp('independent-home')
    const source = await temp('independent-source')
    await plugin(source)
    const { ctx, plugins } = await runtime(home)
    const installed = (await plugins.import(source)).plugins[0]!

    await rm(source, { recursive: true })
    const enabled = (await plugins.enable(installed.identity)).plugins[0]!

    expect(enabled.pluginRoot).toBe(join(home, 'plugins', 'cache', installed.source.sourceId, 'demo-plugin', '1.0.0'))
    expect((await ctx.skills.list()).some(skill => skill.source === `codex-plugin:${installed.identity}`)).toBe(true)
  })

  it('loads root TOML commands, renders arguments, and unloads them with the plugin', async () => {
    const home = await temp('command-runtime-home')
    const source = await temp('command-runtime-source')
    await plugin(source)
    await command(source, 'greet', 'description = "Greet a person"\nprompt = "Hello {{args}} / $ARGUMENTS"\n')
    expect((await new PluginManifestLoader().load(source)).commands).toEqual([{
      name: 'greet', description: 'Greet a person', prompt: 'Hello {{args}} / $ARGUMENTS',
    }])
    const { ctx, plugins } = await runtime(home)
    const identity = (await plugins.import(source)).plugins[0]!.identity
    await plugins.enable(identity)
    const followup = vi.fn()
    const definition = ctx.commands.find({} as never, 'greet')
    expect(definition?.handler({
      commandId: 'test-command' as never,
      agent: { followup } as never,
      rawInput: '  Ada  ', attachments: [], signal: new AbortController().signal,
    })).toEqual({ kind: 'success' })
    expect(followup).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'Hello Ada / Ada' }],
      source: { kind: 'plugin', plugin: `codex-plugin:${identity}` },
    }))
    await plugins.disable(identity)
    expect(ctx.commands.find({} as never, 'greet')).toBeUndefined()
  })

  it('preserves earlier command registrations and rejects invalid command TOML', async () => {
    const home = await temp('command-collision-home')
    const source = await temp('command-collision-source')
    await plugin(source)
    await command(source, 'greet', 'description = "Greet"\nprompt = "Hello"\n')
    const { ctx, plugins } = await runtime(home)
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    ctx.commands.register({ name: 'greet', description: 'Native greet', handler })
    const warn = vi.spyOn(ctx.logger, 'warn')
    await plugins.enable((await plugins.import(source)).plugins[0]!.identity)
    expect(ctx.commands.find({} as never, 'greet')?.handler).toBe(handler)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored because a command with that name is already registered'))

    const invalid = await temp('invalid-command')
    await plugin(invalid)
    await command(invalid, 'bad', 'description = "Broken"')
    await expect(new PluginManifestLoader().load(invalid)).rejects.toThrow('requires non-empty string description and prompt')
  })

  it('cleans up a failed MCP startup when the plugin is disabled', async () => {
    const home = await temp('mcp-runtime-home')
    const source = await temp('mcp-runtime-source')
    await plugin(source, '1.0.0', {
      mcpServers: { unavailable: { command: process.execPath, args: ['--eval', 'process.exit(1)'] } },
    })
    const { plugins } = await runtime(home)
    const identity = (await plugins.import(source)).plugins[0]!.identity
    await plugins.enable(identity)
    await vi.waitFor(async () => {
      expect((await plugins.info(identity)).mcpServers[0]?.startupState).toBe('failed')
    })
    const disabled = await plugins.disable(identity)
    expect(disabled.plugins[0]?.mcpServers[0]?.startupState).toBe('not-started')
  })
})
