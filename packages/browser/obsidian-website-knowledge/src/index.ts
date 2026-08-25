/**
 * Domain-gated Obsidian graph projection for facts observed through BH's
 * embedded browser. It never crosses the configured hostname or invents a
 * deep route: successful `browser_*` results become approval-gated Obsidian
 * MCP graph nodes.
 * @module @bosch/bh-obsidian-website-knowledge
 */

import type { Context } from '@bosch/cordis'
import z from '@bosch/schemastery'
import type { Agent } from '@bosch/bh-agent'
import { credentialRef } from '@bosch/bh-credentials'
import { createUserMessage } from '@bosch/bh-llm'
import { installSettingsSection, settingsNamespace } from '@bosch/bh-settings'
import { defineTool } from '@bosch/bh-tools'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@bosch/bh-tools'
import type {} from '@bosch/bh-system-prompt'
import type {} from '@bosch/bh-tools'
import type { BrowserToolValue } from '@bosch/bh-tool-browser'
import {
  matchesTargetDomain,
  ObsidianWebsiteGraph,
  resolveSettings,
  searchTerms,
  type KnowledgeNote,
  type PageRecord,
  type KnowledgeSearchResult,
  type WebsiteKnowledgeStorage,
  type WebsiteKnowledgeSettings,
} from './graph.ts'
import {
  createObsidianMcpStorage,
  normalizeObsidianMcpUrl,
  type ObsidianMcpOptions,
} from './mcp.ts'

export {
  createLocalObsidianWebsiteGraph,
  controlsFrom,
  hostnameOf,
  matchesTargetDomain,
  normalizeTargetDomain,
  ObsidianWebsiteGraph,
  resolveSettings,
} from './graph.ts'
export type {
  ControlRecord,
  KnowledgeNote,
  KnowledgeSearchResult,
  LocalWebsiteKnowledgeSettings,
  PageRecord,
  ResolvedWebsiteKnowledgeSettings,
  WebsiteKnowledgeStorage,
  WebsiteKnowledgeSettings,
} from './graph.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'obsidian-website-knowledge'

/** This plugin observes browser tools and contributes graph-read and approval-gated knowledge tools. */
export const inject = ['tools', 'systemPrompt']

/** User-settings namespace. */
export const OBSIDIAN_WEBSITE_KNOWLEDGE_SETTINGS_NAMESPACE = settingsNamespace('obsidian-website-knowledge')

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
const OPERATIONAL_BROWSER_PROMPT = 'A direct browser-operation request (open, sign in, navigate, click, search, or create) is not a coverage lookup: take the next safe browser action from the current state before reading UAT. On a fresh window, call browser_state once to load and inspect the configured browser home; do not ask the user to choose a role merely to initialize it. Follow observed navigation links and form-opening actions without another confirmation. Stop only at password/MFA, a failed action, missing required data, or an irreversible submit the user did not authorize.'

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

/** Host composition settings; user settings retain only the target hostname. */
export interface Config {
  /** Initial target hostname, superseded by the user settings section when present. */
  targetDomain?: string
  /** Local Obsidian MCP endpoint; the user settings document never stores this. */
  mcpUrl?: string
}

/** Per-user fields persisted under the website-knowledge settings namespace. */
type UserSettings = WebsiteKnowledgeSettings

export const Config: z<Config> = z.object({
  targetDomain: z.string(),
  mcpUrl: z.string().default('http://127.0.0.1:27123/mcp/'),
})

const UserSettings: z<UserSettings> = z.object({ targetDomain: z.string() })

const PROMPT = (targetDomain: string) => `For website test design, use website_knowledge_search to locate imported UAT and approved knowledge, then call website_knowledge_read_notes with the exact candidate paths before using source fields. These tools use the live Obsidian MCP index and exact note reader; do not call raw Obsidian MCP tools. Search excerpts locate notes only: text absent from an excerpt is not a blank source cell. Search once per distinct term with exactly {"query":"term"}; after exact paths are known, do not repeat paraphrased searches or use glob, grep, or filesystem search to discover the vault. Read up to 32 exact paths per batch and split only when that limit requires it. If Obsidian MCP or a required complete note is unavailable, report Unresolved instead of inferring, inventing, or falling back to filesystem discovery. website_knowledge_read_notes emits same-domain application-root navigation candidates for literal WorkOn application identifiers found in complete notes; these are navigation hypotheses, not UI evidence. website_knowledge_read is only for staged or persisted evidence for the current configured-domain Browser page. Use browser_* only for the configured website; do not call generic web_search or web_fetch. A coverage decision requires a matching complete individual UAT test-case note with the same context, action, and expected result; an index or feature note only identifies candidates. A historical UAT result is not current UI evidence, and no Browser capture cannot prove that UI is unchanged. The configured targetDomain is ${targetDomain}. Resolve the Browser start URL without asking the user for an entrypoint URL. First, when the current conversation contains an exact literal HTTP(S) URL whose hostname matches this targetDomain, pass it unchanged to browser_navigate on the next tool step. Otherwise search website knowledge for the required role plus "browser entrypoint", read the exact approved note, and navigate to its literal same-domain URL. If no approved entrypoint exists, select the emitted navigation candidate whose application matches the required role and complete test-case context, then pass its URL unchanged to browser_navigate on the next tool step. Accept that candidate only when live Browser output establishes the expected application or role. Never navigate to the bare configured domain https://${targetDomain}/, construct another URL, ask the user for an entrypoint URL, guess a feature or deep route, or treat a database, API, SQL, attachment, or evidence-source URL as a UI entrypoint. If no candidate matches or multiple candidates remain plausible, report Blocked and name the missing or conflicting application identity. If live navigation cannot reach the required feature, report Blocked with the Browser URL and observed evidence instead of requesting a link. Navigation URLs remain ephemeral and Browser observations remain staged evidence until website_knowledge_save_approved is called after the user explicitly approves the exact proposed knowledge. When the user asks to verify, validate, check, test, run, or execute a case, call browser_* before reporting a live result, even when imported UAT coverage exists; do not ask a second approval for Browser inspection. If the case lacks test data, a safe cleanup path, or internally consistent steps and expected result, report Blocked rather than invent or alter it. A missing search result or viewport element is not proof that a feature is absent; report Unresolved instead.`

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
      this.ctx.logger.warn(`obsidian-website-knowledge: settings are inactive: ${error instanceof Error ? error.message : String(error)}`)
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
    if (agent === undefined) throw new Error('website knowledge requires an initiating browser agent')
    const tabId = this.latestTabs.get(agent)
    const page = tabId === undefined ? undefined : this.pages.get(agent)?.get(tabId)
    if (page === undefined) throw new Error('browse the configured website before reading its knowledge graph')
    const config = resolveSettings(this.settings())
    if (config === undefined || !matchesTargetDomain(page.url, config.targetDomain)) {
      throw new Error('website knowledge is inactive outside the configured target domain')
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
    if (config === undefined) throw new Error('website knowledge requires configured targetDomain')
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

function graphFor(ctx: Context, settings: () => UserSettings, mcpUrl: string): ObsidianWebsiteGraph {
  const config = resolveSettings(settings())
  if (config === undefined) throw new Error('website knowledge requires configured targetDomain')
  const mcp = createObsidianMcpStorage(mcpOptions(ctx, mcpUrl))
  const storage: WebsiteKnowledgeStorage = {
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
  return new ObsidianWebsiteGraph(config, storage)
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
  installSettingsSection(ctx, OBSIDIAN_WEBSITE_KNOWLEDGE_SETTINGS_NAMESPACE, UserSettings, base, {
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
    if (exec.name === 'website_knowledge_save_approved') {
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
          + 'do not navigate to the BH UI or ask for a link.',
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
    if (exec.name === 'website_knowledge_save_approved') recorder.discardProposal(exec.token)
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
    name: 'browser:obsidian-website-knowledge',
    order: 116,
    text: () => {
      const settings = resolveSettings(current())
      return settings === undefined ? '' : `${OPERATIONAL_BROWSER_PROMPT} ${PROMPT(settings.targetDomain)} ${PROPOSAL_EVIDENCE_PROMPT}`
    },
  })
  ctx.tools.register(defineTool({
    name: 'website_knowledge_read',
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
    presentCall: () => ({ card: 'generic', title: 'Read website knowledge', kind: 'execute' as const }),
  }))
  ctx.tools.register(defineTool({
    name: 'website_knowledge_search',
    description: 'Locate imported UAT cases and website graph notes in the configured Obsidian vault. Returns bounded excerpts and exact paths; use website_knowledge_read_notes before relying on source fields. Call once per term with exactly {"query":"term"}. An empty result is not proof that a feature is absent.',
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
          results: {
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
        },
      },
      render: (_args, value: { query: string; backend: 'obsidian-mcp'; results: readonly KnowledgeSearchResult[] }) => [{
        type: 'text' as const,
        text: value.results.length === 0
          ? `No website knowledge matched via ${value.backend}: ${value.query}`
          : `Website knowledge matches via ${value.backend} for ${value.query}:\n\n${value.results.map(result => `- ${result.path}: ${result.excerpt}`).join('\n')}`,
      }],
    },
    execute: async (args) => {
      searchTerms(args.query)
      return {
        query: args.query,
        backend: 'obsidian-mcp' as const,
        results: await graphFor(ctx, current, mcpUrl).search(args.query),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Search website knowledge: ${args.query}`, kind: 'read' as const }),
  }))
  ctx.tools.register(defineTool({
    name: 'website_knowledge_read_notes',
    description: 'Read complete persisted Obsidian notes by exact extensionless paths returned from website_knowledge_search. Also returns bounded same-domain application-root candidates copied from literal WorkOn identifiers. Use one batch of 1 to 32 paths; the whole call fails rather than returning partial or truncated evidence.',
    parameters: {
      paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact paths returned by website_knowledge_search, without .md extensions.' },
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
        text: `Website knowledge notes via ${value.backend}:\n\n${value.notes.map(note => `Website knowledge note: ${note.path}\n\n${note.markdown}`).join('\n\n---\n\n')}\n\nBrowser navigation candidates from complete notes:\n${value.navigationCandidates.length === 0 ? '- None' : value.navigationCandidates.map(candidate => `- ${candidate.application}: ${candidate.url} (source: ${candidate.sourcePath})`).join('\n')}`,
      }],
    },
    execute: async (args, exec) => {
      const completeNotes = await graphFor(ctx, current, mcpUrl).readNotes(args.paths)
      const settings = resolveSettings(current())
      if (settings === undefined) throw new Error('website knowledge requires configured targetDomain')
      const candidates = navigationCandidates(completeNotes, settings.targetDomain)
      if (exec.agent !== undefined) candidatesByAgent.set(exec.agent, candidates)
      return {
        backend: 'obsidian-mcp' as const,
        notes: completeNotes,
        navigationCandidates: candidates,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Read ${args.paths.length} website knowledge note${args.paths.length === 1 ? '' : 's'}`, kind: 'read' as const }),
  }))
  ctx.tools.register(defineTool({
    name: 'website_knowledge_save_approved',
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
      render: (_args, value: { path: string }) => [{ type: 'text' as const, text: `Saved approved website knowledge: ${value.path}` }],
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
