import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@hydra/cordis'
import SystemPrompt from '@hydra/harness-system-prompt'
import SkillRegistry from '@hydra/harness-skill'
import CommandRuntime from '@hydra/harness-commands'
import type { CommandResult } from '@hydra/harness-commands'
import ToolRuntime from '@hydra/harness-tools'
import { CallId } from '@hydra/harness-llm'
import { publicToolName } from '@hydra/harness-mcp-client/src/tools.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportedPluginRuntime, PluginManifestLoader, PluginStore } from '../src/index.ts'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<(command: string, args: string[], options: object, callback: ExecFileCallback) => void>(),
}))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execFileMock,
}))

const roots: string[] = []

async function temp(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `hydra-plugin-runtime-${label}-`)))
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

async function portablePlugin(root: string, version: string | undefined = '1.0.0', extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(root, 'skills', 'hello'), { recursive: true })
  await writeFile(join(root, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'portable-plugin', version, description: 'fixture', ...extra,
  }))
  await writeFile(join(root, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nHello.')
}

async function claudePlugin(root: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'skills', 'hello'), { recursive: true })
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'claude-plugin', description: 'fixture', ...extra,
  }))
  await writeFile(join(root, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nHello.')
}

async function command(root: string, name: string, source: string): Promise<void> {
  await mkdir(join(root, 'commands'), { recursive: true })
  await writeFile(join(root, 'commands', `${name}.toml`), source)
}

async function markdownCommand(root: string, name: string, source: string): Promise<void> {
  await mkdir(join(root, 'commands'), { recursive: true })
  await writeFile(join(root, 'commands', `${name}.md`), source)
}

async function runtime(home: string): Promise<{ ctx: Context; plugins: ImportedPluginRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ImportedPluginRuntime, { hydraHome: home })
  return { ctx, plugins: ctx.importedPlugins }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  execFileMock.mockReset()
})

describe('PluginStore', () => {
  it('imports the portable root plugin.json format used by Codex', async () => {
    const source = await temp('portable-plugin')
    await portablePlugin(source)
    const store = new PluginStore(await temp('portable-home'))
    const identity = await store.install(source)
    const installed = await store.get(identity)
    expect(installed?.name).toBe('portable-plugin')
    expect((await store.load(installed!, identity)).skills.map(skill => skill.rawName)).toEqual(['hello'])
  })

  it('imports the supported shared subset of a Claude plugin', async () => {
    const source = await temp('claude-plugin')
    await claudePlugin(source)
    const store = new PluginStore(await temp('claude-home'))
    const identity = await store.install(source)
    const installed = await store.get(identity)
    const loaded = await store.load(installed!, identity)
    expect(loaded.manifest).toMatchObject({ format: 'claude', name: 'claude-plugin', version: 'unknown' })
    expect(loaded.skills.map(skill => skill.rawName)).toEqual(['hello'])
  })

  it('reuses Claude default MCP and hook locations', async () => {
    const source = await temp('claude-components')
    await claudePlugin(source)
    await writeFile(join(source, '.mcp.json'), JSON.stringify({ local: { command: 'node' } }))
    await mkdir(join(source, 'hooks'), { recursive: true })
    await writeFile(join(source, 'hooks', 'hooks.json'), JSON.stringify({ Stop: [{ hooks: [{ command: 'echo ready' }] }] }))
    const loaded = await new PluginManifestLoader().load(source, 'claude-plugin@source')
    expect(loaded.mcp.map(server => server.name)).toEqual(['local'])
    expect(loaded.hooks.map(hook => hook.label)).toEqual(['hooks/hooks.json'])
  })

  it('loads Claude root Markdown commands and a single root skill', async () => {
    const source = await temp('claude-command')
    await mkdir(join(source, '.claude-plugin'), { recursive: true })
    await writeFile(join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-command' }))
    await mkdir(join(source, 'commands'), { recursive: true })
    await writeFile(join(source, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nHello $ARGUMENTS.')
    await writeFile(join(source, 'SKILL.md'), '---\nname: root-skill\ndescription: Root skill\n---\nUse this skill.')
    const loaded = await new PluginManifestLoader().load(source)
    expect(loaded.commands).toMatchObject([{ name: 'hello', description: 'Say hello', prompt: 'Hello $ARGUMENTS.' }])
    expect(loaded.skills.map(skill => skill.rawName)).toEqual(['root-skill'])
  })

  it.each(['agents', 'output-styles', 'themes', 'monitors', 'bin', '.lsp.json', 'settings.json'])('rejects unsupported Claude component %s', async (component) => {
    const source = await temp(`claude-${component.replaceAll(/[/.]/gu, '-')}`)
    await claudePlugin(source)
    if (component.startsWith('.')) await writeFile(join(source, component), '{}')
    else await mkdir(join(source, component), { recursive: true })
    await expect(new PluginManifestLoader().load(source)).rejects.toThrow(`Claude plugin component ${component} is unsupported`)
  })

  it('rejects a Claude manifest field whose runtime has no equivalent', async () => {
    const source = await temp('claude-field')
    await claudePlugin(source, { agents: './agents' })
    await expect(new PluginManifestLoader().load(source)).rejects.toThrow('Claude plugin field agents is unsupported')
  })

  it('defaults an omitted portable version and keeps Codex extension components scoped', async () => {
    const source = await temp('portable-defaults')
    await portablePlugin(source, undefined, {
      extensions: { 'com.openai': { skills: './wrong-skills', mcpServers: './wrong-mcp.json' } },
    })
    const manifest = await new PluginManifestLoader().load(source)
    expect(manifest.manifest).toMatchObject({ version: '1.0.0', skills: './skills', mcpServers: './mcp.json' })
    expect(manifest.hooks).toEqual([])
  })

  it('accepts a portable non-semver version used by Codex development bundles', async () => {
    const source = await temp('portable-version')
    await portablePlugin(source, 'release-2026-07')
    expect((await new PluginManifestLoader().load(source)).manifest.version).toBe('release-2026-07')
  })

  it.each(['..', 'release/2026', 'CON'])('rejects an unsafe portable version directory name %s', async (version) => {
    const source = await temp(`portable-unsafe-${version.replaceAll(/[^a-z0-9]/giu, '-')}`)
    await portablePlugin(source, version)
    await expect(new PluginManifestLoader().load(source)).rejects.toThrow('portable plugin version is not a safe directory name')
  })

  it('reads OpenAI metadata and applies explicit-only policy to a skill', async () => {
    const source = await temp('openai-metadata')
    await portablePlugin(source)
    await mkdir(join(source, 'agents'), { recursive: true })
    await writeFile(join(source, 'agents', 'openai.yaml'), [
      'interface:',
      '  display_name: "Portable fixture"',
      '  short_description: "Fixture metadata"',
      '  default_prompt: "Use $hello for fixture work."',
      'policy:',
      '  allow_implicit_invocation: false',
      '',
    ].join('\n'))
    const loaded = await new PluginManifestLoader().load(source)
    expect(loaded.agentMetadata).toMatchObject({
      displayName: 'Portable fixture', allowImplicitInvocation: false,
    })
    expect(loaded.skills[0]?.invocation.modelInvocable).toBe(false)
  })

  it('falls back to the legacy manifest when a root plugin.json is unrelated', async () => {
    const source = await temp('portable-fallback')
    await plugin(source)
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ name: 'unrelated-package', version: '1.0.0' }))
    const manifest = await new PluginManifestLoader().load(source)
    expect(manifest.manifest.format).toBe('legacy')
  })

  it('rejects an unsupported Agent Plugins schema', async () => {
    const source = await temp('portable-schema')
    await writeFile(join(source, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json', name: 'portable-plugin',
    }))
    await expect(new PluginManifestLoader().load(source)).rejects.toThrow(/unsupported Agent Plugins schema/)
  })

  it('uses inline MCP definitions instead of the default file', async () => {
    const root = await temp('inline-mcp')
    await plugin(root, '1.0.0', { mcpServers: { local: { command: 'node' } } })
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ local: { command: 'stale' } }))
    expect((await new PluginManifestLoader().load(root)).mcp.map(server => server.config))
      .toEqual([expect.objectContaining({ command: 'node' })])
  })

  it.each([
    { PreToolUse: [{ matcher: '[', hooks: [{ command: 'echo guard' }] }] },
    { Stop: [] },
    { UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'guard' }] }] },
  ])('rejects imported hook documents the bridge cannot run', async (hooks) => {
    const home = await temp('invalid-hooks-home')
    const source = await temp('invalid-hooks-source')
    await plugin(source, '1.0.0', { hooks })
    const store = new PluginStore(home)
    await expect(store.install(source)).rejects.toThrow()
    expect((await store.list()).size).toBe(0)
  })

  it('discovers a root hooks.json and resolves an override path inside the plugin root', async () => {
    const source = await temp('root-hooks')
    await plugin(source)
    await writeFile(join(source, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'echo root' }] }] } }))
    const loader = new PluginManifestLoader()
    expect((await loader.load(source)).hooks.map(hook => hook.label)).toEqual(['hooks.json'])

    await mkdir(join(source, 'config'), { recursive: true })
    await writeFile(join(source, 'config', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'echo override' }] }] } }))
    await writeFile(join(source, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'demo-plugin', version: '1.0.0', hooks: './config/hooks.json', skills: './skills/',
    }))
    expect((await loader.load(source)).hooks.map(hook => hook.label)).toEqual(['./config/hooks.json'])
  })

  it('parses folded YAML and keeps independent invocation policies on aliases and definitions', async () => {
    const home = await temp('skill-policy-home')
    const source = await temp('skill-policy-source')
    await plugin(source)
    const skillFile = join(source, 'skills', 'hello', 'SKILL.md')
    await writeFile(skillFile, [
      '---', 'name: hello', 'description: >', '  Multiline routing', '  instructions.',
      'whenToUse: |', '  Read this hint.', 'disable-model-invocation: YES', 'user-invocable: OFF',
      '---', 'Hello.', '',
    ].join('\r\n'))
    const { ctx, plugins } = await runtime(home)
    try {
      const identity = (await plugins.import(source)).plugins[0]!.identity
      const enabled = (await plugins.enable(identity)).plugins[0]!
      const summaries = await ctx.skills.list()
      expect(summaries).toHaveLength(2)
      for (const summary of summaries) {
        expect(summary).toMatchObject({
          description: 'Multiline routing instructions.\n', whenToUse: 'Read this hint.\n',
          invocation: { modelInvocable: false, userInvocable: false },
        })
        expect(await ctx.skills.get(summary.name)).toMatchObject({
          name: summary.name, content: 'Hello.', invocation: summary.invocation,
        })
      }
      const installedFile = join(enabled.pluginRoot, 'skills', 'hello', 'SKILL.md')
      await writeFile(installedFile, '---\nname: hello\ndescription: Changed\nuser-invocable: false\n---\nChanged body.')
      expect(await ctx.skills.get('hello')).toMatchObject({
        content: 'Changed body.', description: 'Changed', invocation: { modelInvocable: true, userInvocable: false },
      })
      await writeFile(installedFile, '---\nname: renamed\ndescription: Changed\n---\nChanged body.')
      expect(await ctx.skills.get('hello')).toBeUndefined()
      await plugins.disable(identity)
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    'disable-model-invocation: maybe', 'user-invocable: null', 'disableModelInvocation: true',
    'modelInvocable: false', 'userInvocable: false', 'description: [unclosed',
  ])('rejects invalid imported skill metadata before installation: %s', async (field) => {
    const home = await temp('invalid-skill-home')
    const source = await temp('invalid-skill-source')
    await plugin(source)
    await writeFile(join(source, 'skills', 'hello', 'SKILL.md'), `---\nname: hello\ndescription: Hello\n${field}\n---\nBody.`)
    const store = new PluginStore(home)
    await expect(store.install(source)).rejects.toThrow()
    expect((await store.list()).size).toBe(0)
  })

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

  it('normalizes Codex HTTP type and bearer token environment metadata without storing the token', async () => {
    const root = await temp('mcp-auth')
    await portablePlugin(root, '1.0.0', { mcpServers: './mcp.json' })
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://example.test/mcp', bearer_token_env_var: 'MCP_TEST_TOKEN' },
    } }))
    const loaded = await new PluginManifestLoader().load(root, 'portable-plugin@source')
    expect(loaded.mcp[0]?.config).toMatchObject({
      transport: 'streamable-http', url: 'https://example.test/mcp', bearerTokenEnvVar: 'MCP_TEST_TOKEN', headers: {},
    })
    expect(loaded.mcp[0]?.config).not.toHaveProperty('Authorization')
  })

  it('rejects unsupported portable MCP OAuth metadata explicitly', async () => {
    const root = await temp('mcp-oauth')
    await portablePlugin(root, '1.0.0', { mcpServers: './mcp.json' })
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://example.test/mcp', oauth_resource: 'https://example.test/resource' },
    } }))
    await expect(new PluginManifestLoader().load(root, 'portable-plugin@source'))
      .rejects.toThrow(/OAuth metadata is not supported/u)
  })

  it('reads standard marketplace entries and lets a manifest hook override the default file', async () => {
    const marketplace = await temp('marketplace')
    const pluginRoot = join(marketplace, 'plugins', 'demo-plugin')
    await portablePlugin(pluginRoot, '1.0.0', { name: 'demo-plugin', hooks: { Stop: [{ hooks: [{ command: 'echo reviewed' }] }] } })
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

  it('reads the API-key marketplace filename without applying catalog policy', async () => {
    const marketplace = await temp('api-marketplace')
    const pluginRoot = join(marketplace, 'plugins', 'demo-plugin')
    await plugin(pluginRoot, '1.0.0')
    await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(marketplace, '.agents', 'plugins', 'api_marketplace.json'), JSON.stringify({
      name: 'openai-api-curated',
      interface: { displayName: 'Codex official' },
      plugins: [{
        name: 'demo-plugin',
        source: { source: 'local', path: './plugins/demo-plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
        category: 'Developer Tools',
      }],
    }))

    const store = new PluginStore(await temp('api-marketplace-home'))
    const identity = await store.install({ source: marketplace, plugin: 'demo-plugin' })
    expect((await store.get(identity))?.source.kind).toBe('marketplace-local')
  })

  it('resolves a standard Git-subdirectory marketplace entry', async () => {
    const marketplace = await temp('git-marketplace')
    const repository = await temp('git-plugin-repository')
    await plugin(join(repository, 'plugins', 'demo-plugin'))
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      void cp(repository, String(args.at(-1)), { recursive: true }).then(
        () => { callback(null, '', '') },
        (error: unknown) => { callback(error as Error, '', '') },
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

  it('imports a Git subdirectory through an aliased temporary directory', async () => {
    const repository = await temp('aliased-git-source')
    await plugin(join(repository, 'plugins', 'demo-plugin'))
    const temporary = await temp('aliased-temp')
    const target = join(temporary, 'real')
    const alias = join(temporary, 'alias')
    await mkdir(target)
    await symlink(target, alias, 'junction')
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      void cp(repository, String(args.at(-1)), { recursive: true }).then(
        () => { callback(null, '', '') },
        (error: unknown) => { callback(error as Error, '', '') },
      )
    })
    const store = new PluginStore(await temp('aliased-git-home'))
    try {
      for (const variable of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(variable, alias)
      const identity = await store.install({ source: 'https://example.test/plugins.git', path: 'plugins/demo-plugin' })
      expect((await store.get(identity))?.name).toBe('demo-plugin')
    } finally {
      vi.unstubAllEnvs()
    }
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

  it('rejects a duplicate name from another source until the installed plugin is removed', async () => {
    const left = await temp('left')
    const right = await temp('right')
    const home = await temp('home')
    await plugin(left)
    await plugin(right)
    const store = new PluginStore(home)
    const leftId = await store.install(left)
    await expect(store.install(right)).rejects.toThrow('already installed from another source')
    expect([...(await store.list()).keys()]).toEqual([leftId])

    await store.remove(leftId)
    expect(await store.install(right)).not.toBe(leftId)
  })

  it('removes enabled plugin skills and re-requires hook trust after an upgrade', async () => {
    const home = await temp('runtime-home')
    const source = await temp('runtime-source')
    await plugin(source, '1.0.0', { hooks: { Stop: [{ hooks: [{ command: 'echo reviewed' }] }] } })
    const { ctx, plugins } = await runtime(home)
    const imported = await plugins.import(source)
    const identity = imported.plugins[0]!.identity
    expect(imported.plugins[0]!.hookTrustState).toBe('pending')

    await plugins.enable(identity)
    expect((await ctx.skills.list()).some(skill => skill.source === `codex-plugin:${identity}`)).toBe(true)
    await plugins.disable(identity)
    expect((await ctx.skills.list()).some(skill => skill.source === `codex-plugin:${identity}`)).toBe(false)

    expect((await plugins.trustHooks(identity)).plugins[0]!.hookTrustState).toBe('trusted')
    await plugin(source, '1.1.0', { hooks: { UserPromptSubmit: [{ hooks: [{ command: 'echo reviewed' }] }] } })
    expect((await plugins.import(source)).plugins[0]!.hookTrustState).toBe('pending')
  })

  it('keeps initial enablement until the imported-plugin runtime restarts', async () => {
    const home = await temp('baseline-home')
    const source = await temp('baseline-source')
    await plugin(source)
    const first = await runtime(home)
    const identity = (await first.plugins.import(source)).plugins[0]!.identity
    expect((await first.plugins.enable(identity)).plugins[0]).toMatchObject({ enabled: true, initialEnabled: false })
    await first.ctx.fiber.dispose()
    const second = await runtime(home)
    expect((await second.plugins.list()).plugins[0]).toMatchObject({ enabled: true, initialEnabled: true })
    expect((await second.plugins.disable(identity)).plugins[0]).toMatchObject({ enabled: false, initialEnabled: true })
    await second.ctx.fiber.dispose()
  })

  it('keeps imported registrations owned by the service after an API caller is disposed', async () => {
    const home = await temp('owner-home')
    const source = await temp('owner-source')
    await plugin(source)
    await command(source, 'owned', 'description = "Owned command"\nprompt = "Hello"\n')
    const { ctx, plugins } = await runtime(home)
    try {
      const identity = (await plugins.import(source)).plugins[0]!.identity
      const caller = await ctx.plugin({
        inject: ['importedPlugins'],
        async apply(caller) { await caller.importedPlugins.enable(identity) },
      })
      await caller.dispose()
      expect(await ctx.skills.get('hello')).toBeDefined()
      expect(ctx.commands.find({} as never, 'owned')).toBeDefined()
      await plugins.disable(identity)
      expect(await ctx.skills.get('hello')).toBeUndefined()
      expect(ctx.commands.find({} as never, 'owned')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
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

  it('loads Markdown commands with Codex frontmatter and positional arguments', async () => {
    const home = await temp('markdown-command-home')
    const source = await temp('markdown-command-source')
    await plugin(source)
    await markdownCommand(source, 'review', [
      '---',
      'description: Review the selected target',
      'argument-hint: "[target] [mode]"',
      '---',
      'Review $1 in $2. All: $ARGUMENTS.',
      '',
    ].join('\n'))
    expect((await new PluginManifestLoader().load(source)).commands).toEqual([{
      name: 'review', description: 'Review the selected target', inputHint: '[target] [mode]',
      prompt: 'Review $1 in $2. All: $ARGUMENTS.',
    }])
    const { ctx, plugins } = await runtime(home)
    try {
      const identity = (await plugins.import(source)).plugins[0]!.identity
      await plugins.enable(identity)
      const followup = vi.fn()
      const definition = ctx.commands.find({} as never, 'review')
      expect(definition?.input).toEqual({ hint: '[target] [mode]' })
      expect(definition?.handler({
        commandId: 'test-command' as never,
        agent: { followup } as never,
        rawInput: '  src/index.ts fast  ', attachments: [], signal: new AbortController().signal,
      })).toEqual({ kind: 'success' })
      expect(followup).toHaveBeenCalledWith(expect.objectContaining({
        content: [{ type: 'text', text: 'Review src/index.ts in fast. All: src/index.ts fast.' }],
      }))
    } finally {
      await ctx.fiber.dispose()
    }
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

  it('settles imported MCP startup and enforces raw tool policies after name normalization', async () => {
    const home = await temp('mcp-policy-home')
    const source = await temp('mcp-policy-source')
    const fixture = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))
    await plugin(source, '1.0.0', { mcpServers: { local: { command: process.execPath, args: [fixture] } } })
    const { ctx, plugins } = await runtime(home)
    try {
      const identity = (await plugins.import(source)).plugins[0]!.identity
      const enabled = await plugins.enable(identity)
      await vi.waitFor(async () => {
        expect((await plugins.info(identity)).mcpServers[0]?.startupState).toBe('started')
      }, { timeout: 10_000 })
      const serverName = (await new PluginManifestLoader().load(source, identity)).mcp[0]!.config.serverName
      const execute = (raw: string) => ctx.tools.execute({
        name: publicToolName(serverName, raw), arguments: {}, callId: CallId('policy'), signal: new AbortController().signal,
      })
      expect((await execute('admin__reset')).isError).toBe(true)
      for (const raw of ['admin.reset', 'admin__reset', 'admin-' + 'x'.repeat(80)]) {
        await plugins.setMcpToolApproval(identity, 'local', raw, 'allow')
        expect((await execute(raw)).isError).toBe(false)
        await plugins.setMcpToolApproval(identity, 'local', raw, 'deny')
        const denied = await execute(raw)
        expect(denied.isError).toBe(true)
        expect(denied.content).toEqual([{ type: 'text', text: `Error: MCP tool ${raw} is disabled by its plugin policy` }])
      }
      expect(enabled.plugins[0]?.mcpServers[0]?.startupState).toBe('started')
      await plugins.setMcpServerEnabled(identity, 'local', false)
      expect(ctx.tools.schemas()).toEqual([])
      await plugins.setMcpServerEnabled(identity, 'local', true)
      expect((await execute('admin__reset')).isError).toBe(true)
      await plugins.disable(identity)
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects changes to undeclared MCP servers', async () => {
    const home = await temp('unknown-mcp-home')
    const source = await temp('unknown-mcp-source')
    await plugin(source)
    const { ctx, plugins } = await runtime(home)
    try {
      const identity = (await plugins.import(source)).plugins[0]!.identity
      await expect(plugins.setMcpServerEnabled(identity, 'missing', true)).rejects.toThrow('not declared')
      await expect(plugins.setMcpToolApproval(identity, 'missing', 'tool', 'allow')).rejects.toThrow('not declared')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

async function pluginCommand(ctx: Context, rawInput: string): Promise<CommandResult> {
  const definition = ctx.commands.find({} as never, 'plugin')
  if (definition === undefined) throw new Error('missing /plugin')
  return await definition.handler({
    commandId: 'test-command' as never,
    agent: {} as never,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  })
}

function fakeInventory(initial: Array<{ source: string; status?: string; enabled?: boolean }> = []) {
  const marketplaces = [...initial]
  return {
    marketplaces,
    addMarketplace: vi.fn(async (request: { source: string }) => {
      marketplaces.push({ source: request.source, status: 'ready', enabled: true })
      return { marketplaces: [...marketplaces] }
    }),
    listMarketplaces: vi.fn(async () => ({ marketplaces: [...marketplaces] })),
    removeMarketplace: vi.fn(async (source: string) => {
      const index = marketplaces.findIndex(entry => entry.source === source)
      if (index !== -1) marketplaces.splice(index, 1)
      return { marketplaces: [...marketplaces] }
    }),
  }
}

async function catalog(label: string): Promise<string> {
  const root = await temp(label)
  await plugin(join(root, 'plugins', 'demo-plugin'))
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
  await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'demo-marketplace',
    plugins: [{ name: 'demo-plugin', source: { source: 'local', path: './plugins/demo-plugin/' } }],
  }))
  return root
}

describe('/plugin command', () => {
  it('lists, imports, inspects, enables, and removes through the slash handler', async () => {
    const home = await temp('command-home')
    const source = await temp('command-source')
    await plugin(source)
    const { ctx, plugins } = await runtime(home)

    expect(await pluginCommand(ctx, '')).toEqual({ kind: 'success', text: 'No imported plugins.' })
    expect(await pluginCommand(ctx, 'import')).toMatchObject({ kind: 'error' })
    expect(await pluginCommand(ctx, `import ${source}`)).toEqual({
      kind: 'success', text: 'Plugin imported. It is disabled until explicitly enabled.',
    })
    const identity = (await plugins.list()).plugins[0]!.identity
    expect(await pluginCommand(ctx, 'list')).toEqual({
      kind: 'success', text: `${identity} 1.0.0 disabled`,
    })
    const info = await pluginCommand(ctx, `info ${identity}`)
    expect(info.kind).toBe('success')
    expect(info.text).toContain('demo-plugin')
    expect(info.text).toContain('skills: hello')
    expect(info.text).toContain('MCP: none')
    expect(await pluginCommand(ctx, `enable ${identity}`)).toEqual({ kind: 'success', text: 'Plugin enabled.' })
    expect(await pluginCommand(ctx, 'list')).toEqual({
      kind: 'success', text: `${identity} 1.0.0 enabled`,
    })
    expect(await pluginCommand(ctx, `disable ${identity}`)).toEqual({
      kind: 'success', text: 'Plugin disabled and unloaded.',
    })
    expect(await pluginCommand(ctx, `remove ${identity}`)).toEqual({ kind: 'success', text: 'Plugin removed.' })
    expect(await pluginCommand(ctx, 'list')).toEqual({ kind: 'success', text: 'No imported plugins.' })
  })

  it('trusts and untrusts hooks and reports pending review on list', async () => {
    const home = await temp('command-hooks-home')
    const source = await temp('command-hooks-source')
    await plugin(source, '1.0.0', { hooks: { Stop: [{ hooks: [{ command: 'echo reviewed' }] }] } })
    const { ctx, plugins } = await runtime(home)
    await pluginCommand(ctx, `import ${source}`)
    const identity = (await plugins.list()).plugins[0]!.identity
    expect((await pluginCommand(ctx, 'list')).text).toContain('hook review pending')
    expect(await pluginCommand(ctx, `trust ${identity}`)).toEqual({
      kind: 'success', text: 'Current hook definitions trusted; no MCP/tool approval changed.',
    })
    expect(await pluginCommand(ctx, `untrust ${identity}`)).toEqual({ kind: 'success', text: 'Hook trust removed.' })
  })

  it.each([
    'info', 'enable', 'disable', 'trust', 'untrust', 'remove', 'marketplace', 'marketplace add', 'marketplace remove', 'install',
  ])('returns usage for incomplete %s', async (line) => {
    const { ctx } = await runtime(await temp('command-usage-home'))
    const result = await pluginCommand(ctx, line)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Usage: /plugin')
  })

  it('returns usage for an unknown verb and maps thrown values to error text', async () => {
    const { ctx } = await runtime(await temp('command-error-home'))
    const unknownVerb = await pluginCommand(ctx, 'nope')
    expect(unknownVerb.kind).toBe('error')
    expect(unknownVerb.text).toContain('Usage: /plugin')
    expect(await pluginCommand(ctx, 'import missing-source')).toMatchObject({ kind: 'error' })
    ctx.provide('pluginInventory' as never, {
      addMarketplace: vi.fn(async () => Promise.reject(new Error('catalog boom'))),
      listMarketplaces: vi.fn(async () => ({ marketplaces: [] })),
      removeMarketplace: vi.fn(async () => ({ marketplaces: [] })),
    } as never)
    expect(await pluginCommand(ctx, 'marketplace add owner/repo')).toEqual({ kind: 'error', text: 'catalog boom' })
  })

  it('adds a marketplace through pluginInventory and imports when inventory is absent', async () => {
    const catalogRoot = await catalog('command-catalog')
    const withInventory = await runtime(await temp('command-marketplace-home'))
    const inventory = fakeInventory()
    withInventory.ctx.provide('pluginInventory' as never, inventory as never)
    expect(await pluginCommand(withInventory.ctx, `marketplace add ${catalogRoot}`)).toEqual({
      kind: 'success',
      text: 'Marketplace added. Install a plugin with /plugin install <name>@<marketplace>.',
    })
    expect(inventory.addMarketplace).toHaveBeenCalledWith({ source: catalogRoot })
    expect((await withInventory.plugins.list()).plugins).toHaveLength(0)

    const withoutInventory = await runtime(await temp('command-marketplace-fallback-home'))
    expect(await pluginCommand(withoutInventory.ctx, `marketplace add ${catalogRoot}`)).toEqual({
      kind: 'success', text: 'Plugin imported. It is disabled until explicitly enabled.',
    })
    expect((await withoutInventory.plugins.list()).plugins[0]?.enabled).toBe(false)
  })

  it('lists and removes persisted marketplaces, including unnamed status and disabled slots', async () => {
    const { ctx } = await runtime(await temp('command-marketplace-list-home'))
    expect(await pluginCommand(ctx, 'marketplace list')).toEqual({
      kind: 'error', text: 'plugin runtime: plugin inventory is unavailable',
    })
    expect(await pluginCommand(ctx, 'marketplace remove owner/repo')).toEqual({
      kind: 'error', text: 'plugin runtime: plugin inventory is unavailable',
    })
    const inventory = fakeInventory()
    ctx.provide('pluginInventory' as never, inventory as never)
    expect(await pluginCommand(ctx, 'marketplace list')).toEqual({
      kind: 'success', text: 'No plugin marketplaces.',
    })
    inventory.marketplaces.push(
      { source: 'https://github.com/example-labs/toolkit.git', status: 'ready', enabled: true },
      { source: '/local/catalog' },
      { source: 'example/other', status: 'unavailable', enabled: false },
    )
    expect(await pluginCommand(ctx, 'marketplace list')).toEqual({
      kind: 'success',
      text: [
        'https://github.com/example-labs/toolkit.git ready',
        '/local/catalog ready',
        'example/other unavailable disabled',
      ].join('\n'),
    })
    expect(await pluginCommand(ctx, 'marketplace remove toolkit')).toEqual({
      kind: 'success', text: 'Marketplace removed.',
    })
    expect(inventory.removeMarketplace).toHaveBeenCalledWith('https://github.com/example-labs/toolkit.git')
  })

  it('installs from an explicit source, a catalog selector, and an already imported name', async () => {
    const source = await temp('command-install-source')
    await plugin(source)
    const catalogRoot = await catalog('command-install-catalog')
    const { ctx, plugins } = await runtime(await temp('command-install-home'))
    expect(await pluginCommand(ctx, `install ${source}`)).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
    expect((await plugins.list()).plugins[0]?.enabled).toBe(true)
    expect(await pluginCommand(ctx, 'install demo-plugin')).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
    await pluginCommand(ctx, 'remove demo-plugin')

    const inventory = fakeInventory([{ source: catalogRoot, status: 'ready', enabled: true }])
    ctx.provide('pluginInventory' as never, inventory as never)
    expect(await pluginCommand(ctx, 'install demo-plugin@missing')).toEqual({
      kind: 'error', text: 'plugin runtime: unknown marketplace missing',
    })
    expect(await pluginCommand(ctx, `install demo-plugin@${catalogRoot}`)).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
    await pluginCommand(ctx, 'remove demo-plugin')
    expect(await pluginCommand(ctx, 'install demo-plugin')).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
  })

  it('resolves marketplace names, rejects ambiguous keys, and enables a unique catalog entry', async () => {
    const catalogRoot = await catalog('command-install-key-catalog')
    const { ctx } = await runtime(await temp('command-install-key-home'))
    ctx.provide('pluginInventory' as never, fakeInventory([
      { source: 'https://github.com/example-labs/toolkit.git', status: 'ready', enabled: true },
      { source: 'https://github.com/other/toolkit.git', status: 'ready', enabled: true },
    ]) as never)
    expect(await pluginCommand(ctx, 'install demo-plugin@toolkit')).toEqual({
      kind: 'error', text: 'plugin runtime: marketplace toolkit matches multiple sources',
    })
    expect(await pluginCommand(ctx, 'install demo-plugin')).toEqual({
      kind: 'error', text: 'plugin runtime: imported plugin demo-plugin is not installed',
    })

    const single = await runtime(await temp('command-install-unique-home'))
    single.ctx.provide('pluginInventory' as never, fakeInventory([
      { source: catalogRoot, status: 'ready', enabled: true },
    ]) as never)
    expect(await pluginCommand(single.ctx, 'install demo-plugin')).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
  })

  it('treats Git URLs and scp sources as explicit install sources and maps an empty import', async () => {
    const pluginRoot = await temp('command-git-plugin')
    await plugin(pluginRoot)
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      void cp(pluginRoot, String(args.at(-1)), { recursive: true }).then(
        () => { callback(null, '', '') },
        (error: unknown) => { callback(error as Error, '', '') },
      )
    })
    const { ctx, plugins } = await runtime(await temp('command-git-home'))
    expect(await pluginCommand(ctx, 'install https://example.test/demo.git')).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
    await plugins.remove((await plugins.list()).plugins[0]!.identity)
    expect(await pluginCommand(ctx, 'install owner/demo')).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
    await plugins.remove((await plugins.list()).plugins[0]!.identity)
    expect(await pluginCommand(ctx, 'install git@github.com:owner/demo.git')).toEqual({
      kind: 'success', text: 'Plugin demo-plugin enabled.',
    })
    await plugins.remove((await plugins.list()).plugins[0]!.identity)
    expect(await pluginCommand(ctx, 'install owner\\demo')).toMatchObject({ kind: 'error' })

    vi.spyOn(plugins, 'import').mockResolvedValueOnce({ plugins: [] })
    expect(await pluginCommand(ctx, `install ${pluginRoot}`)).toEqual({
      kind: 'error', text: 'plugin runtime: import produced no plugin',
    })
  })

  it('rejects an unknown marketplace name when inventory is absent', async () => {
    const { ctx } = await runtime(await temp('command-unknown-marketplace-home'))
    expect(await pluginCommand(ctx, 'install demo-plugin@toolkit')).toEqual({
      kind: 'error', text: 'plugin runtime: unknown marketplace toolkit',
    })
    expect(await pluginCommand(ctx, 'install demo-plugin')).toEqual({
      kind: 'error', text: 'plugin runtime: imported plugin demo-plugin is not installed',
    })
  })
})
