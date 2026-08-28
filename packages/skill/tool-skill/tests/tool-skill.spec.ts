import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@bosch/cordis'
import { createToolResultMessage, createUserMessage, CallId } from '@bosch/bh-llm'
import { createScope, type Scope } from '@bosch/bh-scope'
import { Session, SessionId, type UserMessage } from '@bosch/bh-session'
import SystemPrompt from '@bosch/bh-system-prompt'
import ToolRuntime from '@bosch/bh-tools'
import AgentRegistry, { agentEvents, Inbox, type Agent, type PreStepDecision } from '@bosch/bh-agent'
import SkillRegistry from '@bosch/bh-skill'
import * as SkillFileSystem from '@bosch/bh-skill-filesystem'
import * as toolSkill from '@bosch/bh-tool-skill'

const testToolSignal = new AbortController().signal

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `bh-${name}-`)))
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(home: string, config: toolSkill.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { bhHome: join(home, '.bh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkill, config)
  return ctx
}

function agentForCwd(cwd: string): Agent {
  const id = SessionId(`tool-skill-${cwd}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function proposeStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
): Promise<PreStepDecision> {
  const signal = new AbortController().signal
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}


async function mintAgentScope(ctx: Context, subject: string | Agent): Promise<{ agent: Agent; scope: Scope }> {
  const agent = typeof subject === 'string' ? agentForCwd(subject) : subject
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['skills', 'tools'],
  }))
  return { agent, scope }
}

describe('bh-tool-skill', () => {
  it('registers bounded search and exact loading without injecting a catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const home = await tempDir('tool-schema')
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { bhHome: join(home, '.bh'), agentsHome: join(home, '.agents'), watch: false })
    ctx.skills.register({ name: 'lifecycle-skill', description: 'Lifecycle', source: 'runtime', content: 'body' })

    const fiber = await ctx.plugin(toolSkill)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill', 'skill_search'])
    expect(await proposeStep(ctx, agentForCwd('/workspace'), [])).toEqual({ kind: 'enter', messages: [] })
    expect(ctx.tools.get('skill')?.presentCall?.({ name: 'project-skill' })).toEqual({
      card: 'generic',
      title: 'Load skill project-skill',
      kind: 'read',
      rawInput: 'project-skill',
    })
    expect(ctx.tools.get('skill_search')?.presentCall?.({ query: 'project task' })).toEqual({
      card: 'generic',
      title: 'Search skills',
      kind: 'read',
      rawInput: 'project task',
    })

    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])

    toolSkill.apply(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill', 'skill_search'])
  })

  it('searches one hundred summaries within count bounds and loads no body until exact selection', async () => {
    const home = await tempDir('tool-bounded-search')
    const ctx = await setup(home, { searchMaxResults: 3 })
    const getCalls: string[] = []
    ctx.skills.registerProvider(() => ({
      name: 'bulk-provider',
      async list() {
        return Array.from({ length: 100 }, (_, index) => {
          const skillName = 'bulk-skill-' + index.toString().padStart(3, '0')
          return {
            name: skillName,
            description: `Bulk routing skill ${index}`,
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'bulk-provider',
            source: 'test',
            rank: 1,
            locator: skillName,
          }
        })
      },
      async get(candidate) {
        getCalls.push(candidate.name)
        return { ...candidate, content: 'Body for ' + candidate.name }
      },
    }))

    const search = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-bulk'),
      name: 'skill_search',
      arguments: { query: 'bulk routing skill' },
    })

    expect(search.isError).toBe(false)
    if (search.isError) throw new Error('expected skill search success')
    expect(search.value).toEqual({
      complete: true,
      truncated: true,
      matches: [
        { name: 'bulk-skill-000', description: 'Bulk routing skill 0' },
        { name: 'bulk-skill-001', description: 'Bulk routing skill 1' },
        { name: 'bulk-skill-002', description: 'Bulk routing skill 2' },
      ],
    })
    expect(getCalls).toEqual([])
    expect(JSON.stringify(search.content)).not.toContain('Body for')

    const load = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('load-bulk'),
      name: 'skill',
      arguments: { name: 'bulk-skill-000' },
    })
    expect(load.isError).toBe(false)
    expect(getCalls).toEqual(['bulk-skill-000'])
  })

  it('defaults greetings to no match and ranks name, description, and whenToUse metadata', async () => {
    const home = await tempDir('tool-routing')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'name-hit',
      description: 'Unrelated summary',
      source: 'runtime',
      content: 'Name body.',
    })
    ctx.skills.register({
      name: 'description-hit',
      description: 'Orchard banana workflow',
      source: 'runtime',
      content: 'Description body.',
    })
    ctx.skills.register({
      name: 'when-hit',
      description: 'Different summary',
      whenToUse: 'Orchard banana mango operations',
      source: 'runtime',
      content: 'When body.',
    })
    ctx.skills.register({
      name: 'zero-tie',
      description: 'Orchard banana workflow',
      source: 'runtime',
      content: 'Zero body.',
    })
    ctx.skills.register({
      name: 'hidden-greeting',
      description: 'Greeting hello hi',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'Hidden body.',
    })

    const greeting = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-hi'),
      name: 'skill_search',
      arguments: { query: 'hi' },
    })
    const metadata = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-metadata'),
      name: 'skill_search',
      arguments: { query: 'orchard banana mango' },
    })
    const exactName = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-name'),
      name: 'skill_search',
      arguments: { query: 'name hit' },
    })
    const empty = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-empty'),
      name: 'skill_search',
      arguments: { query: '---' },
    })

    if (greeting.isError || metadata.isError || exactName.isError || empty.isError) throw new Error('expected skill search success')
    expect(greeting.value).toEqual({ complete: true, truncated: false, matches: [] })
    expect(empty.value).toEqual({ complete: true, truncated: false, matches: [] })
    expect(metadata.value).toEqual({
      complete: true,
      truncated: false,
      matches: [
        { name: 'when-hit', description: 'Different summary', whenToUse: 'Orchard banana mango operations' },
        { name: 'description-hit', description: 'Orchard banana workflow' },
        { name: 'zero-tie', description: 'Orchard banana workflow' },
      ],
    })
    expect(exactName.value).toEqual({
      complete: true,
      truncated: false,
      matches: [
        { name: 'name-hit', description: 'Unrelated summary' },
        { name: 'description-hit', description: 'Orchard banana workflow' },
        { name: 'when-hit', description: 'Different summary', whenToUse: 'Orchard banana mango operations' },
      ],
    })
  })

  it('returns partial candidates and forwards cwd, scope, and cancellation without loading', async () => {
    const home = await tempDir('tool-partial-search')
    const ctx = await setup(home)
    let seenCwd: string | undefined
    let seenSignal: AbortSignal | undefined
    ctx.skills.register({
      name: 'stable-skill',
      description: 'Stable routing',
      source: 'runtime',
      content: 'Stable body.',
    })
    ctx.skills.registerProvider(() => ({
      name: 'failing-provider',
      async list(options) {
        seenCwd = options.cwd
        seenSignal = options.signal
        throw new Error('temporarily unavailable')
      },
      async get() {
        return undefined
      },
    }))
    const agent = agentForCwd('/workspace/scoped')
    const { scope } = await mintAgentScope(ctx, agent)
    scope.ctx.skills.register({
      name: 'scoped-skill',
      description: 'Scoped routing',
      source: 'runtime',
      content: 'Scoped body.',
    })

    const partial = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-partial'),
      name: 'skill_search',
      arguments: { query: 'stable scoped routing' },
      agent,
    })
    const outside = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-outside'),
      name: 'skill_search',
      arguments: { query: 'scoped routing' },
      agent: agentForCwd('/workspace/other'),
    })

    if (partial.isError || outside.isError) throw new Error('expected skill search success')
    expect(partial.value).toEqual({
      complete: false,
      truncated: false,
      matches: [
        { name: 'scoped-skill', description: 'Scoped routing' },
        { name: 'stable-skill', description: 'Stable routing' },
      ],
    })
    expect(outside.value).toEqual({
      complete: false,
      truncated: false,
      matches: [{ name: 'stable-skill', description: 'Stable routing' }],
    })
    expect(seenCwd).toBe('/workspace/other')
    expect(seenSignal).toBe(testToolSignal)
    await scope.dispose()
  })

  it('bounds multibyte results and validates every search limit', async () => {
    const home = await tempDir('tool-byte-cap')
    const byteLimit = 420
    const ctx = await setup(home, {
      searchDescriptionMaxLength: 500,
      searchMaxResultBytes: byteLimit,
    })
    ctx.skills.register({
      name: 'huge-skill',
      description: '界'.repeat(501),
      source: 'runtime',
      content: 'Huge body.',
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('search-byte-cap'),
      name: 'skill_search',
      arguments: { query: 'huge skill' },
    })

    if (result.isError) throw new Error('expected skill search success')
    expect(result.value).toEqual({ complete: true, truncated: true, matches: [] })
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text search result')
    expect(Buffer.byteLength(block.text, 'utf8')).toBeLessThanOrEqual(byteLimit)

    await expect(setup(await tempDir('tool-count-cap'), { searchMaxResults: 0 })).rejects.toThrow('searchMaxResults')
    await expect(setup(await tempDir('tool-description-cap'), { searchDescriptionMaxLength: 2 })).rejects.toThrow('searchDescriptionMaxLength')
    await expect(setup(await tempDir('tool-result-cap'), { searchMaxResultBytes: 1 })).rejects.toThrow('searchMaxResultBytes')
  })

  it('loads a skill for the calling agent cwd', async () => {
    const home = await tempDir('tool-load')
    const project = await tempDir('tool-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.bh/skills'), 'project-skill', 'Project skill', 'Project instructions.')
    const ctx = await setup(home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('c1'),
      name: 'skill',
      arguments: { name: 'project-skill' },
      agent: { session: { header: { cwd: project } } } as never,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    expect(result.value).toEqual({
      name: 'project-skill',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(project, '.bh/skills/project-skill') },
      content: 'Project instructions.',
    })
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected text skill result')
    expect(block.text).toBe([
      '<skill_content name="project-skill">',
      '<skill_resources>',
      `Base directory for this skill: ${join(project, '.bh/skills/project-skill')}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      'Project instructions.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n'))
    expect(block.text).not.toContain('# Skill:')
  })

  it('renders provider-managed resource hints for non-local skills', async () => {
    const home = await tempDir('tool-resource-hints')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'opaque-skill',
      description: 'Opaque skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'opaque', description: 'runtime memory' },
      content: 'Opaque instructions.',
    })
    ctx.skills.register({
      name: 'url-skill',
      description: 'URL skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'url', url: 'https://skills.example.test/url-skill' },
      content: 'URL instructions.',
    })
    ctx.skills.register({
      name: 'provider-skill',
      description: 'Provider skill',
      source: 'runtime',
      provider: 'runtime',
      content: 'Provider instructions.',
    })

    const opaque = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c2'), name: 'skill', arguments: { name: 'opaque-skill' } })
    const url = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c3'), name: 'skill', arguments: { name: 'url-skill' } })
    const provider = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c4'), name: 'skill', arguments: { name: 'provider-skill' } })

    if (opaque.content[0]?.type !== 'text' || url.content[0]?.type !== 'text' || provider.content[0]?.type !== 'text') {
      throw new Error('expected text tool results')
    }
    expect(opaque.content[0].text).toContain('<skill_resources>\nResources for this skill: runtime memory\nLoad referenced resources only as needed.\n</skill_resources>')
    expect(url.content[0].text).toContain('<skill_resources>\nBase URL for this skill: https://skills.example.test/url-skill\nResolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.\n</skill_resources>')
    expect(provider.content[0].text).toContain('<skill_resources>\nResources for this skill are managed by provider "runtime".\nLoad referenced resources only as needed.\n</skill_resources>')
  })

  it('rejects an unknown resource-base kind at the canonical output boundary', async () => {
    const home = await tempDir('tool-resource-assert-never')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'rogue-resource-skill',
      description: 'Rogue resource skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'future' } as never,
      content: 'Rogue instructions.',
    })

    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c5'), name: 'skill', arguments: { name: 'rogue-resource-skill' } })

    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_TOOL_OUTPUT')
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text tool result')
    expect(block.text).toContain('value.resourceBase')
  })

  it('returns isError for unknown, invalid, and model-disabled skills', async () => {
    const home = await tempDir('tool-errors')
    await writeSkill(join(home, '.bh/skills'), 'hidden-skill', 'Hidden skill', 'Hidden instructions.')
    await writeFile(join(home, '.bh/skills/hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: Hidden skill\ndisable-model-invocation: true\n---\n\nHidden instructions.\n')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only instructions.',
    })

    const unknown = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'skill', arguments: { name: 'missing' } })
    const invalid = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c2'), name: 'skill', arguments: { name: 'Bad_Name' } })
    const disabled = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c3'), name: 'skill', arguments: { name: 'hidden-skill' } })
    const modelOnly = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c4'), name: 'skill', arguments: { name: 'model-only-skill' } })

    expect(unknown.isError).toBe(true)
    expect(invalid.isError).toBe(true)
    expect(disabled.isError).toBe(true)
    expect(modelOnly.isError).toBe(false)
    const unknownBlock = unknown.content[0]
    if (unknownBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(unknownBlock.text).toContain('skill "missing" is unknown or no longer available')
  })

  it('checks model policy before provider loading and rechecks the loaded definition', async () => {
    const home = await tempDir('tool-policy-before-load')
    const ctx = await setup(home)
    const getCalls: string[] = []
    ctx.skills.registerProvider(() => ({
      name: 'policy-probe',
      async list() {
        return [
          {
            name: 'denied-skill',
            description: 'Denied skill',
            invocation: { modelInvocable: false, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'denied-skill',
          },
          {
            name: 'policy-race-skill',
            description: 'Policy race skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'policy-race-skill',
          },
          {
            name: 'vanishing-skill',
            description: 'Vanishing skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'vanishing-skill',
          },
        ]
      },
      async get(candidate) {
        getCalls.push(candidate.name)
        if (candidate.name === 'vanishing-skill') return undefined
        return {
          ...candidate,
          invocation: { modelInvocable: false, userInvocable: true },
          content: 'Instructions must not be disclosed.',
        }
      },
    }))

    const denied = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c6'), name: 'skill', arguments: { name: 'denied-skill' } })
    const raced = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c7'), name: 'skill', arguments: { name: 'policy-race-skill' } })
    const vanished = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c8'), name: 'skill', arguments: { name: 'vanishing-skill' } })

    expect(denied.isError).toBe(true)
    expect(raced.isError).toBe(true)
    expect(vanished.isError).toBe(true)
    expect(getCalls).toEqual(['policy-race-skill', 'vanishing-skill'])
    for (const result of [denied, raced]) {
      const block = result.content[0]
      if (block?.type !== 'text') throw new Error('expected text tool result')
      expect(block.text).toContain('is not available for model invocation')
      expect(block.text).not.toContain('Instructions must not be disclosed.')
    }
    const vanishedBlock = vanished.content[0]
    if (vanishedBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(vanishedBlock.text).toContain('skill "vanishing-skill" is unknown or no longer available')
  })
})

describe('automatic invocation injection', () => {
  function user(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  function skillInjections(decision: PreStepDecision): UserMessage[] {
    return decision.kind === 'enter'
      ? decision.messages.filter(message => (message.source as { kind?: string }).kind === 'skill-invocation')
      : []
  }

  async function automaticHarness(): Promise<{ ctx: Context; agent: Agent }> {
    const home = await tempDir('automatic-invocation')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'workon-uat-test-design',
      description: 'Ground WorkON testcase lookup and test design in Obsidian knowledge.',
      whenToUse: 'Use for WorkON testcase lookup, test design, or live validation.',
      source: 'runtime',
      content: 'Use obsidian_knowledge_recall before designing WorkON tests.',
    })
    ctx.skills.register({
      name: 'shared-skill',
      description: 'Explicit shared instructions',
      source: 'runtime',
      content: 'Shared instructions.',
    })
    ctx.skills.register({
      name: 'test',
      description: 'Generic test instructions',
      source: 'runtime',
      content: 'Generic test body.',
    })
    return { ctx, agent: agentForCwd(home) }
  }

  it('loads the unique strong WorkON match directly from Vietnamese user text', async () => {
    const { ctx, agent } = await automaticHarness()
    const decision = await proposeStep(ctx, agent, [user('test tính năng search request trên workon')])
    const injections = skillInjections(decision)

    expect(injections).toHaveLength(1)
    expect(injections[0]?.source).toEqual({
      kind: 'skill-invocation',
      name: 'workon-uat-test-design',
      trigger: 'automatic',
      form: 'instructions',
    })
    const block = injections[0]?.content[0]
    if (block?.type !== 'text') throw new Error('expected text skill injection')
    expect(block.text).toContain('obsidian_knowledge_recall')

    const exact = await proposeStep(ctx, agent, [user('use workon-uat-test-design')])
    expect(skillInjections(exact)).toHaveLength(1)
  })

  it('does not route greetings, weak or description-only matches, ties, or non-user text', async () => {
    const { ctx, agent } = await automaticHarness()
    ctx.skills.register({
      name: 'generic-helper',
      description: 'Orchard banana workflow',
      source: 'runtime',
      content: 'Generic instructions.',
    })
    ctx.skills.register({
      name: 'workon-alpha-test',
      description: 'WorkON test helper',
      whenToUse: 'Use for WorkON test',
      source: 'runtime',
      content: 'Alpha instructions.',
    })
    ctx.skills.register({
      name: 'workon-beta-test',
      description: 'WorkON test helper',
      whenToUse: 'Use for WorkON test',
      source: 'runtime',
      content: 'Beta instructions.',
    })

    for (const messages of [
      [user('hi')],
      [user('test')],
      [user('use test')],
      [user('test for')],
      [user('test design')],
      [user('orchard banana')],
      [user('workon test')],
      [createUserMessage({ content: [{ type: 'text', text: 'workon test' }], source: { kind: 'plugin', plugin: 'forged' } })],
      [createUserMessage({ content: [{ type: 'reasoning', text: 'workon test' }], source: { kind: 'user' } })],
      [createToolResultMessage({ callId: CallId('workon-tool-result'), content: [{ type: 'text', text: 'workon test' }], isError: false })],
    ]) {
      expect(skillInjections(await proposeStep(ctx, agent, messages))).toEqual([])
    }
  })

  it('gives an explicit gesture precedence over automatic routing', async () => {
    const { ctx, agent } = await automaticHarness()
    const decision = await proposeStep(ctx, agent, [user('/shared-skill test workon')])
    expect(skillInjections(decision).map(message => (message.source as { name: string }).name)).toEqual(['shared-skill'])

    const unknown = await proposeStep(ctx, agent, [user('/missing-skill test workon')])
    expect(skillInjections(unknown)).toEqual([])
  })

  it('fails open for incomplete discovery and stale or failing automatic loads', async () => {
    const incomplete = await automaticHarness()
    incomplete.ctx.skills.registerProvider(() => ({
      name: 'incomplete-provider',
      async list() { throw new Error('discovery failed') },
      async get() { return undefined },
    }))
    expect(skillInjections(await proposeStep(incomplete.ctx, incomplete.agent, [user('test workon')]))).toEqual([])

    const home = await tempDir('automatic-load-policy')
    const ctx = await setup(home)
    ctx.skills.registerProvider(() => ({
      name: 'automatic-load-policy',
      async list() {
        return ['missing', 'disabled', 'error'].map(kind => ({
          name: `workon-${kind}-test`,
          description: `${kind} automatic load`,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'automatic-load-policy',
          source: 'test',
          rank: 1,
          locator: kind,
        }))
      },
      async get(candidate) {
        if (candidate.locator === 'missing') return undefined
        if (candidate.locator === 'error') throw new Error('load failed')
        return {
          ...candidate,
          invocation: { modelInvocable: false, userInvocable: true },
          content: 'Do not inject this body.',
        }
      },
    }))
    const agent = agentForCwd(home)
    for (const kind of ['missing', 'disabled', 'error']) {
      const decision = await proposeStep(ctx, agent, [user(`use workon-${kind}-test`)])
      expect(skillInjections(decision)).toEqual([])
    }
  })

  it('fails open for invalid discovery without swallowing cancellation', async () => {
    const invalidHome = await tempDir('automatic-invalid-discovery')
    const invalid = await setup(invalidHome)
    invalid.skills.registerProvider(() => ({
      name: 'invalid-provider',
      async list() { return [{ name: 'Invalid_Name' }] as never },
      async get() { return undefined },
    }))
    const invalidDecision = await proposeStep(invalid, agentForCwd(invalidHome), [user('workon test')])
    expect(skillInjections(invalidDecision)).toEqual([])

    const abortHome = await tempDir('automatic-aborted-discovery')
    const aborted = await setup(abortHome)
    const controller = new AbortController()
    aborted.skills.registerProvider(() => ({
      name: 'aborting-provider',
      async list() {
        controller.abort()
        return []
      },
      async get() { return undefined },
    }))
    const agent = agentForCwd(abortHome)
    await expect(agentEvents(aborted, agent).waterfall(
      'agent/pre-step',
      { messages: [user('workon test')], turn: 1, step: 1, signal: controller.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user('workon test')] }),
    )).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('user-explicit invocation injection', () => {
  async function writePolicySkill(root: string, name: string, description: string, policy: string, body: string): Promise<void> {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    const policyLines = policy === '' ? '' : `${policy}\n`
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${policyLines}---\n\n${body}\n`)
  }

  function gesture(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  async function invokeHarness(): Promise<{ ctx: Context; agent: Agent }> {
    const home = await tempDir('invoke')
    const skillsRoot = join(home, '.agents', 'skills')
    await writePolicySkill(skillsRoot, 'hidden-demo', 'User-only demo', 'disable-model-invocation: true', 'Say the magic word: PINEAPPLE.')
    await writePolicySkill(skillsRoot, 'shared-skill', 'Ordinary skill', '', 'Shared instructions.')
    await writePolicySkill(skillsRoot, 'model-only-skill', 'Model only', 'user-invocable: false', 'Model-only instructions.')
    const ctx = await setup(home)
    return { ctx, agent: agentForCwd(home) }
  }

  it('injects a user-invocable skill named by a leading /token, after every other injection', async () => {
    const { ctx, agent } = await invokeHarness()
    const first = gesture('/hidden-demo what does this do')
    const second = gesture('plain follow-up prose')
    const decision = await proposeStep(ctx, agent, [first, second])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const kinds = decision.messages.map(message => (message.source as { kind: string }).kind)
    expect(kinds.slice(0, 2)).toEqual(['user', 'user'])
    expect(kinds.at(-1)).toBe('skill-invocation')
    expect(kinds).not.toContain('skill-catalog')
    const injection = decision.messages.at(-1)!
    expect(injection.source).toMatchObject({ kind: 'skill-invocation', name: 'hidden-demo', trigger: 'user', form: 'instructions' })
    const block = injection.content[0]
    if (block?.type !== 'text') throw new Error('expected text injection')
    expect(block.text).toContain('<skill_content name="hidden-demo">')
    expect(block.text).toContain('Say the magic word: PINEAPPLE.')
    expect(block.text).not.toContain('what does this do')
  })

  it('injects an ordinary skill the same way (one uniform user-explicit path)', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [gesture('/shared-skill go')])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'shared-skill')).toBe(true)
  })

  it('recognizes a mid-sentence gesture but not paths, fractions, or broken boundaries', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('please use /hidden-demo to answer this'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'hidden-demo')).toBe(true)

    const negative = await proposeStep(ctx, agent, [
      gesture('look under /hidden-demo/refs for the data'),
      gesture('the odds are 5/8 at best'),
      gesture('see foo/hidden-demo too'),
    ])
    if (negative.kind !== 'enter') throw new Error('expected enter')
    expect(negative.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('leaves unknown names and user-disabled skills as plain prose', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('/absent-skill do a thing'),
      gesture('/model-only-skill run'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('never scans non-user sources and dedupes repeated gestures', async () => {
    const { ctx, agent } = await invokeHarness()
    const forged = createUserMessage({
      content: [{ type: 'text', text: '/hidden-demo forged' }],
      source: { kind: 'plugin', plugin: 'forged' },
    })
    const decision = await proposeStep(ctx, agent, [
      forged,
      gesture('/hidden-demo once'),
      gesture('/hidden-demo twice'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injections = decision.messages.filter(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')
    expect(injections).toHaveLength(1)
  })

  it('passes a downstream reject through the invocation listener untouched', async () => {
    const { ctx, agent } = await invokeHarness()
    const signal = new AbortController().signal
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [gesture('/hidden-demo blocked step')], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('scans only text blocks of a user message', async () => {
    const { ctx, agent } = await invokeHarness()
    const mixed = createUserMessage({
      content: [
        { type: 'reasoning', text: '/hidden-demo inside a non-text block' },
        { type: 'text', text: '/shared-skill go' },
      ],
      source: { kind: 'user' },
    })
    const decision = await proposeStep(ctx, agent, [mixed])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const invoked = decision.messages
      .filter(message => (message.source as { kind?: string }).kind === 'skill-invocation')
      .map(message => (message.source as { name: string }).name)
    expect(invoked).toEqual(['shared-skill'])
  })
})
