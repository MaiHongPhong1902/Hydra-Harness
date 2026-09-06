/**
 * Obsidian graph memory with bounded contextual recall and optional
 * domain-gated Browser evidence capture.
 * @module @hydra/harness-obsidian-knowledge
 */

import type { Context } from '@hydra/cordis'
import z from '@hydra/schemastery'
import type { Agent } from '@hydra/harness-agent'
import { credentialRef } from '@hydra/harness-credentials'
import { createUserMessage } from '@hydra/harness-llm'
import { installSettingsSection, settingsNamespace } from '@hydra/harness-settings'
import { defineTool } from '@hydra/harness-tools'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@hydra/harness-tools'
import type {} from '@hydra/harness-system-prompt'
import type {} from '@hydra/harness-tools'
import type { BrowserToolValue } from '@hydra/harness-tool-browser'
import {
  matchesTargetDomain,
  ObsidianKnowledgeGraph,
  resolveSettings,
  searchTerms,
  type KnowledgeNote,
  type KnowledgeRecall,
  type PageRecord,
  type ObsidianKnowledgeStorage,
  type ObsidianKnowledgeSettings,
} from './graph.ts'
import {
  createObsidianMcpStorage,
  normalizeObsidianMcpUrl,
  type ObsidianMcpOptions,
} from './mcp.ts'

export {
  createLocalObsidianKnowledgeGraph,
  controlsFrom,
  hostnameOf,
  matchesTargetDomain,
  normalizeTargetDomain,
  ObsidianKnowledgeGraph,
  resolveSettings,
} from './graph.ts'
export type {
  ControlRecord,
  KnowledgeNote,
  KnowledgeSearchResult,
  KnowledgeRecall,
  KnowledgeRelation,
  LocalObsidianKnowledgeSettings,
  ObsidianKnowledgeSettings,
  ObsidianKnowledgeStorage,
  PageRecord,
  ResolvedObsidianKnowledgeSettings,
} from './graph.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'obsidian-knowledge'

/** This plugin observes browser tools and contributes graph-read and approval-gated knowledge tools. */
export const inject = ['tools', 'systemPrompt']

/** User-settings namespace. */
export const OBSIDIAN_KNOWLEDGE_SETTINGS_NAMESPACE = settingsNamespace('obsidian-knowledge')

const DEFAULT_OBSIDIAN_MCP_URL = 'http://127.0.0.1:27123/mcp/'
const OBSIDIAN_MCP_API_KEY = credentialRef('OBSIDIAN_API_KEY')
const OBSIDIAN_MCP_TIMEOUT_MS = 5_000
const APPLICATION_IDENTIFIER = /\bWorkOn[A-Za-z][A-Za-z0-9_-]{1,79}\b/g
const HTTP_URL = /https?:\/\/[^\s<>"'`]+/g
const LIVE_VERIFICATION_REQUESTS = [
  /\b(?:verify|validate|execute|retest|re-test)\b/iu,
  /\brun\b.{0,40}\b(?:test|case|tc[-_ ]?\d+)\b/iu,
  /\btest\s+(?:this|these|the|tc[-_ ]?\d+)/iu,
  /kiểm chứng|xác thực|kiểm tra (?:trực tiếp|trên (?:ui|giao diện)|bằng browser)/iu,
  /(?:chạy|thực thi|test)\s+(?:lại\s+|thử\s+)?(?:test|case|tc[-_ ]?\d+)/iu,
] as const
const MAX_NAVIGATION_CANDIDATES = 16
const PROPOSAL_EVIDENCE_PROMPT = 'In an approved proposal evidence field, list every live Browser result URL that belongs to that proposal. The host attaches only those exact current-turn results, or previous-turn results when approval is the next user turn.'

interface NavigationCandidate {
  readonly application: string
  readonly url: string
  readonly sourcePath: string
}

interface BrowserObservation {
  readonly turn: number | undefined
  readonly previous: PageRecord | undefined
  readonly operation: string
  readonly arguments_: unknown
  readonly page: PageRecord
  readonly action: BrowserToolValue['action']
}

interface PendingProposal {
  readonly agent: Agent
  readonly observations: readonly BrowserObservation[]
}

/** Host composition settings; targetDomain activates optional Browser capture. */
export interface Config {
  /** Initial target hostname, superseded by the user settings section when present. */
  targetDomain?: string
  /** Local Obsidian MCP endpoint; the user settings document never stores this. */
  mcpUrl?: string
}

/** Per-user fields persisted under the Obsidian knowledge settings namespace. */
type UserSettings = ObsidianKnowledgeSettings

export const Config: z<Config> = z.object({
  targetDomain: z.string(),
  mcpUrl: z.string().default('http://127.0.0.1:27123/mcp/'),
})

const UserSettings: z<UserSettings> = z.object({ targetDomain: z.string() })

const MEMORY_PROMPT = 'Use obsidian_knowledge_recall once per distinct intent. It returns short ranked context plus exact related paths from Obsidian wikilinks; choose the needed paths, then call obsidian_knowledge_read once with up to 32 paths before relying on source fields. An excerpt or graph edge locates evidence but does not prove a blank field or absent feature. Do not call raw Obsidian MCP tools or search the vault through glob, grep, or filesystem tools. If MCP or a required complete note is unavailable, report Unresolved instead of inferring. Coverage requires a complete individual UAT case with matching context, action, and expected result; feature and index notes only identify candidates.'
const BROWSER_PROMPT = (targetDomain: string) => `Use obsidian_knowledge_read_browser only for current Browser evidence on ${targetDomain}; historical notes cannot prove the current UI. Direct open, sign-in, navigation, click, search, or create requests start with the next safe browser_* action, using browser_state once on a fresh window. For an entrypoint, prefer an exact same-domain URL already in the conversation; otherwise recall the required role plus "browser entrypoint", read that note, then use its literal URL or a matching application candidate emitted by obsidian_knowledge_read. Never navigate to bare https://${targetDomain}/, construct a deep route, request an entrypoint URL, or treat API, SQL, attachment, or evidence URLs as UI routes. Block on conflicting identity, missing test data, unsafe cleanup, password/MFA, failed action, or an unauthorized irreversible submit. A verify, validate, check, test, run, or execute request requires browser_* before a live verdict. Browser observations remain staged until obsidian_knowledge_save_approved receives explicit approval.`

function navigationCandidates(notes: readonly KnowledgeNote[], targetDomain: string): NavigationCandidate[] {
  const candidates: NavigationCandidate[] = []
  const seen = new Set<string>()
  for (const note of notes) {
    for (const application of note.markdown.match(APPLICATION_IDENTIFIER) ?? []) {
      const key = application.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ application, url: `https://${targetDomain}/${application}/`, sourcePath: note.path })
      if (candidates.length === MAX_NAVIGATION_CANDIDATES) return candidates
    }
  }
  return candidates
}

function isBareTargetDomainNavigation(arguments_: unknown, targetDomain: string): boolean {
  if (arguments_ === null || typeof arguments_ !== 'object') return false
  const value = (arguments_ as { url?: unknown }).url
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname === targetDomain
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

/** URL-bearing browser operations that can create a fresh navigation target. */
function browserNavigationUrl(exec: ToolExecution): string | undefined {
  if (exec.name !== 'browser_navigate' && exec.name !== 'browser_open_tab') return undefined
  if (exec.arguments === null || typeof exec.arguments !== 'object') return undefined
  const url = (exec.arguments as { url?: unknown }).url
  return typeof url === 'string' ? url : undefined
}

function evidenceUrls(evidence: string, targetDomain: string): Set<string> {
  const urls = new Set<string>()
  for (const token of evidence.match(HTTP_URL) ?? []) {
    const value = token.replace(/[),.;\]}]+$/, '')
    if (matchesTargetDomain(value, targetDomain)) urls.add(new URL(value).href)
  }
  return urls
}

function isBrowserValue(value: unknown): value is BrowserToolValue {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.url === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.header === 'string'
    && typeof candidate.content === 'string'
    && typeof candidate.footer === 'string'
    && Array.isArray(candidate.tabs)
    && typeof candidate.tabId === 'number'
    && typeof candidate.activeTabId === 'number'
    && typeof candidate.settled === 'boolean'
    && typeof candidate.capturedAt === 'string'
    && typeof candidate.truncated === 'boolean'
}

function browserResult(exec: ToolExecution, result: ToolExecutionResult): BrowserToolValue | undefined {
  if (!exec.name.startsWith('browser_') || result.isError || !('value' in result)) return undefined
  return isBrowserValue(result.value) ? result.value : undefined
}

class BrowserKnowledgeRecorder {
  private pages = new WeakMap<Agent, Map<number, PageRecord>>()
  private latestTabs = new WeakMap<Agent, number>()
  private staged = new WeakMap<Agent, BrowserObservation[]>()
  private turns = new WeakMap<Agent, number>()
  private proposals = new Map<ToolExecutionToken, PendingProposal>()

  constructor(
    private readonly ctx: Context,
    private readonly settings: () => UserSettings,
    private readonly mcpUrl: string,
  ) {}

  reset(): void {
    this.pages = new WeakMap()
    this.latestTabs = new WeakMap()
    this.staged = new WeakMap()
    this.turns = new WeakMap()
    this.proposals.clear()
  }

  beginTurn(agent: Agent, turn: number): void {
    this.turns.set(agent, turn)
    const staged = this.staged.get(agent)
    if (staged === undefined) return
    const retained = staged.filter(observation => observation.turn === undefined || observation.turn >= turn - 1)
    if (retained.length === 0) this.staged.delete(agent)
    else this.staged.set(agent, retained)
  }

  observe(exec: ToolExecution, value: BrowserToolValue): void {
    const agent = exec.agent
    if (agent === undefined) return
    if (!value.settled) {
      this.pages.get(agent)?.delete(value.tabId)
      this.latestTabs.delete(agent)
      return
    }
    let config
    try {
      config = resolveSettings(this.settings())
    } catch (error) {
      this.ctx.logger.warn(`obsidian-knowledge: settings are inactive: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (config === undefined || !matchesTargetDomain(value.url, config.targetDomain)) {
      this.pages.get(agent)?.delete(value.tabId)
      this.latestTabs.delete(agent)
      return
    }
    const graph = graphFor(this.ctx, this.settings, this.mcpUrl)
    const pages = this.pages.get(agent) ?? new Map<number, PageRecord>()
    const previous = pages.get(value.tabId)
    const page = graph.page(value)
    pages.set(value.tabId, page)
    this.pages.set(agent, pages)
    this.latestTabs.set(agent, value.tabId)
    const staged = this.staged.get(agent) ?? []
    staged.push({
      turn: this.turns.get(agent),
      previous,
      operation: exec.name,
      arguments_: exec.arguments,
      page,
      action: value.action,
    })
    this.staged.set(agent, staged)
  }

  async read(agent: Agent | undefined): Promise<{ url: string; markdown: string }> {
    if (agent === undefined) throw new Error('Obsidian browser knowledge requires an initiating browser agent')
    const tabId = this.latestTabs.get(agent)
    const page = tabId === undefined ? undefined : this.pages.get(agent)?.get(tabId)
    if (page === undefined) throw new Error('browse the configured website before reading its knowledge graph')
    const config = resolveSettings(this.settings())
    if (config === undefined || !matchesTargetDomain(page.url, config.targetDomain)) {
      throw new Error('Obsidian browser knowledge is inactive outside the configured target domain')
    }
    const graph = graphFor(this.ctx, this.settings, this.mcpUrl)
    return { url: page.url, markdown: await graph.read(page) || graph.describe(page) }
  }

  stageProposal(exec: ToolExecution, evidence: string): void {
    const agent = exec.agent
    if (agent === undefined) return
    const config = resolveSettings(this.settings())
    if (config === undefined) return
    const urls = evidenceUrls(evidence, config.targetDomain)
    const turn = this.turns.get(agent)
    const matching = (this.staged.get(agent) ?? [])
      .filter(observation => urls.has(new URL(observation.page.url).href))
    const current = turn === undefined ? matching : matching.filter(observation => observation.turn === turn)
    const observations = current.length > 0 || turn === undefined
      ? current
      : matching.filter(observation => observation.turn === turn - 1)
    this.proposals.set(exec.token, { agent, observations })
  }

  discardProposal(token: ToolExecutionToken): void {
    this.proposals.delete(token)
  }

  async commit(token: ToolExecutionToken): Promise<void> {
    const proposal = this.proposals.get(token)
    if (proposal === undefined || proposal.observations.length === 0) return
    const config = resolveSettings(this.settings())
    if (config === undefined) throw new Error('Obsidian browser knowledge requires configured targetDomain')
    const graph = graphFor(this.ctx, this.settings, this.mcpUrl)
    for (const observation of proposal.observations) {
      await graph.record(
        observation.previous,
        observation.operation,
        observation.arguments_,
        observation.page,
        observation.action,
      )
    }
    const committed = new Set(proposal.observations)
    const remaining = (this.staged.get(proposal.agent) ?? []).filter(observation => !committed.has(observation))
    if (remaining.length === 0) this.staged.delete(proposal.agent)
    else this.staged.set(proposal.agent, remaining)
    this.proposals.delete(token)
  }
}

function requireObsidianMcp<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error('Obsidian MCP is unavailable; enable the local Obsidian MCP server and configure OBSIDIAN_API_KEY')
  }
  return value
}

function graphFor(ctx: Context, settings: () => UserSettings, mcpUrl: string): ObsidianKnowledgeGraph {
  const config = resolveSettings(settings())
  const mcp = createObsidianMcpStorage(mcpOptions(ctx, mcpUrl))
  const storage: ObsidianKnowledgeStorage = {
    read: async path => (await mcp.readNote(path))?.markdown ?? '',
    write: async (path, markdown) => {
      requireObsidianMcp(await mcp.writeNote({ path, markdown }))
    },
    update: async (path, render) => {
      const current = (await mcp.readNote(path))?.markdown ?? ''
      requireObsidianMcp(await mcp.writeNote({ path, markdown: render(current) }))
    },
    search: async query => requireObsidianMcp(await mcp.search(query)),
    readNotes: async paths => requireObsidianMcp(await mcp.readNotes(paths)),
  }
  return new ObsidianKnowledgeGraph(config, storage)
}

function mcpOptions(ctx: Context, mcpUrl: string): ObsidianMcpOptions {
  return {
    url: mcpUrl,
    timeoutMs: OBSIDIAN_MCP_TIMEOUT_MS,
    resolveApiKey: async () => (await ctx.get('credentials')?.resolve(OBSIDIAN_MCP_API_KEY))?.value,
  }
}

/** Register settings, stage target-domain Browser facts, and expose graph tools to the model. */
export function apply(ctx: Context, config: Config = {}): void {
  const mcpUrl = normalizeObsidianMcpUrl(config.mcpUrl ?? DEFAULT_OBSIDIAN_MCP_URL)
  const base: UserSettings = config.targetDomain === undefined ? {} : { targetDomain: config.targetDomain }
  resolveSettings(base)
  let current: () => UserSettings = () => base
  const recorder = new BrowserKnowledgeRecorder(ctx, () => current(), mcpUrl)
  const candidateTurns = new WeakMap<Agent, number>()
  const candidatesByAgent = new WeakMap<Agent, readonly NavigationCandidate[]>()
  const verificationTurns = new WeakMap<Agent, number>()
  const browserAttemptTurns = new WeakMap<Agent, number>()
  const browserReminderTurns = new WeakMap<Agent, number>()
  installSettingsSection(ctx, OBSIDIAN_KNOWLEDGE_SETTINGS_NAMESPACE, UserSettings, base, {
    setSource: (source) => { current = source },
    onChange: () => { recorder.reset() },
    validate: (value) => { resolveSettings(value) },
  })
  ctx.on('agent/pre-step', ({ agent, messages, turn }, next) => {
    recorder.beginTurn(agent, turn)
    if (messages.some(message =>
      message.source.kind === 'user'
      && message.content.some(block => block.type === 'text'
        && LIVE_VERIFICATION_REQUESTS.some(pattern => pattern.test(block.text))))) {
      verificationTurns.set(agent, turn)
    }
    if (candidateTurns.get(agent) !== turn) {
      candidateTurns.set(agent, turn)
      candidatesByAgent.delete(agent)
    }
    return next()
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'obsidian_knowledge_save_approved') {
      const arguments_ = exec.arguments as { evidence?: unknown }
      recorder.stageProposal(exec, typeof arguments_.evidence === 'string' ? arguments_.evidence : '')
      return Promise.resolve({
        kind: 'ask' as const,
        reason: 'Saving or replacing Obsidian knowledge requires explicit user approval for this exact proposal.',
      })
    }
    const settings = resolveSettings(current())
    const candidates = exec.agent === undefined ? undefined : candidatesByAgent.get(exec.agent)
    const activeTurn = exec.agent === undefined ? undefined : candidateTurns.get(exec.agent)
    const requestedUrl = browserNavigationUrl(exec)
    if (settings !== undefined
      && exec.agent !== undefined
      && activeTurn !== undefined
      && verificationTurns.get(exec.agent) === activeTurn
      && requestedUrl !== undefined
      && !matchesTargetDomain(requestedUrl, settings.targetDomain)) {
      return Promise.resolve({
        kind: 'deny' as const,
        reason: `Live WorkON verification cannot navigate outside the configured target domain ${settings.targetDomain}. `
          + 'Read the complete testcase note and use its matching application-root candidate; '
          + 'do not navigate to the Hydra UI or ask for a link.',
      })
    }
    if (settings !== undefined
      && requestedUrl !== undefined
      && isBareTargetDomainNavigation(exec.arguments, settings.targetDomain)) {
      return Promise.resolve({
        kind: 'deny' as const,
        reason: candidates !== undefined && candidates.length > 0
          ? `Bare target-domain navigation is not a WorkON application entrypoint. Use the candidate matching the complete testcase context: ${candidates.map(candidate => `${candidate.application} -> ${candidate.url} (source: ${candidate.sourcePath})`).join('; ')}`
          : 'Bare target-domain navigation is not a WorkON application entrypoint. Read the complete testcase knowledge note and use its matching application-root candidate.',
      })
    }
    if (settings !== undefined
      && exec.agent !== undefined
      && activeTurn !== undefined
      && verificationTurns.get(exec.agent) === activeTurn
      && requestedUrl !== undefined
      && matchesTargetDomain(requestedUrl, settings.targetDomain)) {
      browserAttemptTurns.set(exec.agent, activeTurn)
    }
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'obsidian_knowledge_save_approved') recorder.discardProposal(exec.token)
    const value = browserResult(exec, result)
    if (value !== undefined) {
      recorder.observe(exec, value)
      const settings = resolveSettings(current())
      const activeTurn = exec.agent === undefined ? undefined : candidateTurns.get(exec.agent)
      if (settings !== undefined
        && exec.agent !== undefined
        && activeTurn !== undefined
        && verificationTurns.get(exec.agent) === activeTurn
        && matchesTargetDomain(value.url, settings.targetDomain)) {
        browserAttemptTurns.set(exec.agent, activeTurn)
      }
    }
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const candidates = candidatesByAgent.get(agent)
    if (verificationTurns.get(agent) !== turn
      || candidateTurns.get(agent) !== turn
      || candidates === undefined
      || candidates.length === 0
      || browserAttemptTurns.get(agent) === turn
      || browserReminderTurns.get(agent) === turn) return
    browserReminderTurns.set(agent, turn)
    agent.steer(createUserMessage({
      source: { kind: 'plugin', plugin: name },
      content: [{
        type: 'text',
        text: 'This is a live testcase verification request. Before reporting a live result, call browser_navigate with the application candidate matching the complete testcase context, then inspect Browser evidence. If navigation cannot be attempted, report Blocked and do not reuse the historical UAT status as a live verdict.',
      }],
    }))
  })
  ctx.systemPrompt.section({
    name: 'memory:obsidian-knowledge',
    order: 116,
    text: () => {
      const settings = resolveSettings(current())
      return settings === undefined
        ? `${MEMORY_PROMPT} ${PROPOSAL_EVIDENCE_PROMPT}`
        : `${MEMORY_PROMPT} ${BROWSER_PROMPT(settings.targetDomain)} ${PROPOSAL_EVIDENCE_PROMPT}`
    },
  })
  ctx.tools.register(defineTool({
    name: 'obsidian_knowledge_read_browser',
    description: 'Read staged Browser evidence or the persisted Obsidian graph note for the current configured-domain browser page. Browse that page first.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          markdown: { type: 'string', required: true },
        },
      },
      render: (_args, value: { url: string; markdown: string }) => [{
        type: 'text' as const,
        text: `Knowledge graph for ${value.url}\n\n${value.markdown}`,
      }],
    },
    execute: async (_args, exec) => recorder.read(exec.agent),
    presentCall: () => ({ card: 'generic', title: 'Read Browser knowledge', kind: 'execute' as const }),
  }))
  ctx.tools.register(defineTool({
    name: 'obsidian_knowledge_recall',
    description: 'Recall concise Obsidian context and exact related paths by following wikilinks from the strongest matches. Call once per intent, then batch the needed paths through obsidian_knowledge_read. An empty result is not proof that a feature is absent.',
    parameters: {
      query: { type: 'string', required: true, description: 'Focused feature, UI, or test-case terms (2 to 160 characters).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          backend: { type: 'string', required: true, enum: ['obsidian-mcp'] },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
                excerpt: { type: 'string', required: true },
              },
            },
          },
          related: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
                sourcePath: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { query: string; backend: 'obsidian-mcp' } & KnowledgeRecall) => [{
        type: 'text' as const,
        text: value.matches.length === 0
          ? `No Obsidian knowledge matched via ${value.backend}: ${value.query}`
          : `Obsidian knowledge recall via ${value.backend} for ${value.query}:\n\nMatches:\n${value.matches.map(result => `- ${result.path}: ${result.excerpt}`).join('\n')}\n\nRelated exact paths:\n${value.related.length === 0 ? '- None' : value.related.map(relation => `- ${relation.path} (from ${relation.sourcePath})`).join('\n')}`,
      }],
    },
    execute: async (args) => {
      searchTerms(args.query)
      const recall = await graphFor(ctx, current, mcpUrl).recall(args.query)
      return {
        query: args.query,
        backend: 'obsidian-mcp' as const,
        matches: [...recall.matches],
        related: [...recall.related],
      }
    },
    presentCall: args => ({ card: 'generic', title: `Recall Obsidian knowledge: ${args.query}`, kind: 'read' as const }),
  }))
  ctx.tools.register(defineTool({
    name: 'obsidian_knowledge_read',
    description: 'Read 1 to 32 complete Obsidian notes by exact extensionless paths returned from recall. With targetDomain configured, complete notes also yield bounded application-root Browser candidates. The whole batch fails rather than returning partial or truncated evidence.',
    parameters: {
      paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact paths returned by obsidian_knowledge_recall, without .md extensions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string', required: true, enum: ['obsidian-mcp'] },
          notes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                markdown: { type: 'string', required: true },
              },
            },
          },
          navigationCandidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                application: { type: 'string', required: true },
                url: { type: 'string', required: true },
                sourcePath: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { backend: 'obsidian-mcp'; notes: readonly KnowledgeNote[]; navigationCandidates: readonly NavigationCandidate[] }) => [{
        type: 'text' as const,
        text: `Obsidian knowledge notes via ${value.backend}:\n\n${value.notes.map(note => `Obsidian knowledge note: ${note.path}\n\n${note.markdown}`).join('\n\n---\n\n')}\n\nBrowser navigation candidates from complete notes:\n${value.navigationCandidates.length === 0 ? '- None' : value.navigationCandidates.map(candidate => `- ${candidate.application}: ${candidate.url} (source: ${candidate.sourcePath})`).join('\n')}`,
      }],
    },
    execute: async (args, exec) => {
      const completeNotes = await graphFor(ctx, current, mcpUrl).readNotes(args.paths)
      const settings = resolveSettings(current())
      const candidates = settings === undefined ? [] : navigationCandidates(completeNotes, settings.targetDomain)
      if (exec.agent !== undefined) candidatesByAgent.set(exec.agent, candidates)
      return {
        backend: 'obsidian-mcp' as const,
        notes: completeNotes,
        navigationCandidates: candidates,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Read ${args.paths.length} Obsidian note${args.paths.length === 1 ? '' : 's'}`, kind: 'read' as const }),
  }))
  ctx.tools.register(defineTool({
    name: 'obsidian_knowledge_save_approved',
    description: 'Save approved test knowledge to the configured Obsidian vault. Call only after the user explicitly approves the exact proposal; approval must be the literal approved-by-user.',
    parameters: {
      approval: { type: 'string', required: true, const: 'approved-by-user', description: 'Literal confirmation after explicit user approval.' },
      title: { type: 'string', required: true, description: 'Short title for the approved proposal.' },
      content: { type: 'string', required: true, description: 'Approved test cases or knowledge, including uncertainty where applicable.' },
      evidence: { type: 'string', required: true, description: 'User context, source-note paths, and every exact live Browser result URL to attach from the current or immediately previous turn.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true } },
      },
      render: (_args, value: { path: string }) => [{ type: 'text' as const, text: `Saved approved Obsidian knowledge: ${value.path}` }],
    },
    execute: async (args, exec) => {
      const graph = graphFor(ctx, current, mcpUrl)
      graph.validateApproved(args.title, args.content, args.evidence)
      await recorder.commit(exec.token)
      return { path: await graph.saveApproved(args.title, args.content, args.evidence) }
    },
    presentCall: args => ({ card: 'generic', title: `Save approved knowledge: ${args.title}`, kind: 'execute' as const }),
  }))
}
