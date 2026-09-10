/**
 * Obsidian graph memory with bounded contextual recall and approval-gated writes.
 * @module @hydra/harness-obsidian-knowledge
 */

import type { Context } from '@hydra/cordis'
import z from '@hydra/schemastery'
import { credentialRef } from '@hydra/harness-credentials'
import { installSettingsSection, settingsNamespace } from '@hydra/harness-settings'
import { defineTool } from '@hydra/harness-tools'
import type {} from '@hydra/harness-system-prompt'
import type {} from '@hydra/harness-tools'
import {
  ObsidianKnowledgeGraph,
  searchTerms,
  type KnowledgeNote,
  type KnowledgeRecall,
} from './graph.ts'
import {
  createObsidianMcpStorage,
  normalizeObsidianMcpUrl,
  type ObsidianMcpOptions,
} from './mcp.ts'

export {
  createLocalObsidianKnowledgeGraph,
  ObsidianKnowledgeGraph,
} from './graph.ts'
export type {
  KnowledgeNote,
  KnowledgeSearchResult,
  KnowledgeRecall,
  KnowledgeRelation,
  LocalObsidianKnowledgeSettings,
  ObsidianKnowledgeStorage,
} from './graph.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'obsidian-knowledge'

/** This plugin contributes graph-read and approval-gated knowledge tools. */
export const inject = ['tools', 'systemPrompt']

/** User-settings namespace. */
export const OBSIDIAN_KNOWLEDGE_SETTINGS_NAMESPACE = settingsNamespace('obsidian-knowledge')

const DEFAULT_OBSIDIAN_MCP_URL = 'http://127.0.0.1:27123/mcp/'
const OBSIDIAN_MCP_API_KEY = credentialRef('OBSIDIAN_API_KEY')
const OBSIDIAN_MCP_TIMEOUT_MS = 5_000

/** Host composition settings. */
export interface Config {
  /** Local Obsidian MCP endpoint; the user settings document never stores this. */
  mcpUrl?: string
}

export const Config: z<Config> = z.object({
  mcpUrl: z.string().default('http://127.0.0.1:27123/mcp/'),
})

const UserSettings = z.object({})

const MEMORY_PROMPT = 'Use obsidian_knowledge_recall once per distinct intent. It returns short ranked context plus exact related paths from Obsidian wikilinks; choose the needed paths, then call obsidian_knowledge_read once with up to 32 paths before relying on source fields. An excerpt or graph edge locates evidence but does not prove a blank field or absent feature. Do not call raw Obsidian MCP tools or search the vault through glob, grep, or filesystem tools. If MCP or a required complete note is unavailable, report Unresolved instead of inferring. Coverage requires a complete individual UAT case with matching context, action, and expected result; feature and index notes only identify candidates.'
const PROPOSAL_EVIDENCE_PROMPT = 'In an approved proposal evidence field, list the user context and source-note paths that justify the proposal.'

function requireObsidianMcp<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error('Obsidian MCP is unavailable; enable the local Obsidian MCP server and configure OBSIDIAN_API_KEY')
  }
  return value
}

function graphFor(ctx: Context, mcpUrl: string): ObsidianKnowledgeGraph {
  const mcp = createObsidianMcpStorage(mcpOptions(ctx, mcpUrl))
  return new ObsidianKnowledgeGraph({
    write: async (path, markdown) => {
      requireObsidianMcp(await mcp.writeNote({ path, markdown }))
    },
    search: async query => requireObsidianMcp(await mcp.search(query)),
    readNotes: async paths => requireObsidianMcp(await mcp.readNotes(paths)),
  })
}

function mcpOptions(ctx: Context, mcpUrl: string): ObsidianMcpOptions {
  return {
    url: mcpUrl,
    timeoutMs: OBSIDIAN_MCP_TIMEOUT_MS,
    resolveApiKey: async () => (await ctx.get('credentials')?.resolve(OBSIDIAN_MCP_API_KEY))?.value,
  }
}

/** Register settings and expose graph tools to the model. */
export function apply(ctx: Context, config: Config = {}): void {
  const mcpUrl = normalizeObsidianMcpUrl(config.mcpUrl ?? DEFAULT_OBSIDIAN_MCP_URL)
  installSettingsSection(ctx, OBSIDIAN_KNOWLEDGE_SETTINGS_NAMESPACE, UserSettings, {}, {
    setSource: () => {},
    onChange: () => {},
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'obsidian_knowledge_save_approved') {
      return Promise.resolve({
        kind: 'ask' as const,
        reason: 'Saving or replacing Obsidian knowledge requires explicit user approval for this exact proposal.',
      })
    }
    return next()
  })
  ctx.systemPrompt.section({
    name: 'memory:obsidian-knowledge',
    order: 116,
    text: () => `${MEMORY_PROMPT} ${PROPOSAL_EVIDENCE_PROMPT}`,
  })
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
      const recall = await graphFor(ctx, mcpUrl).recall(args.query)
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
    description: 'Read 1 to 32 complete Obsidian notes by exact extensionless paths returned from recall. The whole batch fails rather than returning partial or truncated evidence.',
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
        },
      },
      render: (_args, value: { backend: 'obsidian-mcp'; notes: readonly KnowledgeNote[] }) => [{
        type: 'text' as const,
        text: `Obsidian knowledge notes via ${value.backend}:\n\n${value.notes.map(note => `Obsidian knowledge note: ${note.path}\n\n${note.markdown}`).join('\n\n---\n\n')}`,
      }],
    },
    execute: async (args) => {
      const completeNotes = await graphFor(ctx, mcpUrl).readNotes(args.paths)
      return {
        backend: 'obsidian-mcp' as const,
        notes: completeNotes,
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
      evidence: { type: 'string', required: true, description: 'User context and source-note paths that justify the proposal.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true } },
      },
      render: (_args, value: { path: string }) => [{ type: 'text' as const, text: `Saved approved Obsidian knowledge: ${value.path}` }],
    },
    execute: async (args) => {
      const graph = graphFor(ctx, mcpUrl)
      graph.validateApproved(args.title, args.content, args.evidence)
      return { path: await graph.saveApproved(args.title, args.content, args.evidence) }
    },
    presentCall: args => ({ card: 'generic', title: `Save approved knowledge: ${args.title}`, kind: 'execute' as const }),
  }))
}
