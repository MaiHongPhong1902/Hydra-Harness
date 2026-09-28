/**
 * Bounded skill routing, model-facing search, and exact loading.
 *
 * @module @hydraharness/harness-tool-skill
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import type { PreStepDecision } from '@hydraharness/harness-agent'
import { defineTool } from '@hydraharness/harness-tools'
import { createUserMessage } from '@hydraharness/harness-llm'
import type { UserMessage } from '@hydraharness/harness-session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@hydraharness/harness-skill'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']

const DEFAULT_SEARCH_MAX_RESULTS = 5
const DEFAULT_SEARCH_DESCRIPTION_MAX_LENGTH = 500
const DEFAULT_SEARCH_MAX_RESULT_BYTES = 8_192

interface SkillSearchMatch {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

interface SkillSearchResult {
  readonly complete: boolean
  readonly truncated: boolean
  readonly matches: SkillSearchMatch[]
}

/** Model-facing skill search configuration. */
export interface Config {
  /** Maximum candidates returned by one search; minimum 1. */
  searchMaxResults?: number
  /** Maximum normalized description or routing-hint length per candidate; minimum 3. */
  searchDescriptionMaxLength?: number
  /** Maximum UTF-8 bytes in one rendered search result. */
  searchMaxResultBytes?: number
}

/** Validate and default the model-facing skill search configuration. */
export const Config: z<Config> = z.object({
  searchMaxResults: z.number().default(DEFAULT_SEARCH_MAX_RESULTS),
  searchDescriptionMaxLength: z.number().default(DEFAULT_SEARCH_DESCRIPTION_MAX_LENGTH),
  searchMaxResultBytes: z.number().default(DEFAULT_SEARCH_MAX_RESULT_BYTES),
})

/**
 * Register bounded automatic routing, model-facing search, exact loading, and direct user invocation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const searchMaxResults = config.searchMaxResults ?? DEFAULT_SEARCH_MAX_RESULTS
  const searchDescriptionMaxLength = config.searchDescriptionMaxLength ?? DEFAULT_SEARCH_DESCRIPTION_MAX_LENGTH
  const searchMaxResultBytes = config.searchMaxResultBytes ?? DEFAULT_SEARCH_MAX_RESULT_BYTES
  assertPositiveInteger('searchMaxResults', searchMaxResults)
  assertPositiveInteger('searchDescriptionMaxLength', searchDescriptionMaxLength, 3)
  assertPositiveInteger('searchMaxResultBytes', searchMaxResultBytes, minimumSearchResultBytes())

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for exactly one skill. Use only an exact name returned by `skill_search` for the current task or explicitly named by the user; do not guess names or reload an inline <skill_content> block.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name returned by `skill_search` or explicitly named by the user.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)

  const skillSearchTool = defineTool({
    name: 'skill_search',
    description: 'Find a bounded shortlist of skills for a substantive user task before loading one. Search with concise task keywords; do not call this for greetings, thanks, acknowledgements, casual chat, meta questions, or vague requests. An empty result means load no skill.',
    parameters: {
      query: { type: 'string', required: true, description: 'Concise keywords describing the user task, not a greeting or conversational filler.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          complete: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                whenToUse: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillSearchResult(value) }],
    },
    async execute(args, exec) {
      const snapshot = await ctx.skills.snapshot({
        cwd: exec.agent?.session.header.cwd,
        signal: exec.signal,
        scope: exec.agent,
      })
      exec.signal.throwIfAborted()
      return boundedSearchResult(
        rankSkills(snapshot.skills.filter(isModelInvocable), args.query).map(entry => entry.skill),
        snapshot.complete,
        searchMaxResults,
        searchDescriptionMaxLength,
        searchMaxResultBytes,
      )
    },
    presentCall(args) {
      return { card: 'generic', title: 'Search skills', kind: 'read', rawInput: args.query }
    },
  })
  ctx.tools.register(skillSearchTool)

  // Skill invocation: an explicit `/<name>` gesture takes precedence; otherwise
  // a complete registry snapshot may contribute one unambiguous strong match.
  // The rendered body enters this step as instructions context after every
  // other injection, closest to the model's answer.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // model-facing search and loader never expose them.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    const task = directUserText(messages)
    if (names.length === 0 && task === '') return decision
    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const injections: UserMessage[] = []
    if (names.length === 0) {
      if (vetoesAutomaticSkill(task)) return decision
      try {
        const snapshot = await ctx.skills.snapshot(lookup)
        signal.throwIfAborted()
        if (!snapshot.complete) return decision
        const selected = automaticallySelectedSkill(rankSkills(snapshot.skills.filter(isModelInvocable), task))
        if (selected === undefined) return decision
        const skill = await ctx.skills.get(selected.name, lookup)
        signal.throwIfAborted()
        if (skill === undefined || !isModelInvocable(skill)) return decision
        const source: SkillInvocationSource = {
          kind: 'skill-invocation', name: skill.name, trigger: 'automatic', form: 'instructions',
        }
        injections.push(createUserMessage({
          content: [{ type: 'text', text: renderSkillContent(skill) }],
          source,
        }))
      } catch (error) {
        signal.throwIfAborted()
        ctx.logger.warn(`tool-skill: automatic routing failed: ${String(error)}`)
        return decision
      }
    }
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, trigger: 'user', form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source,
      }))
    }
    if (injections.length === 0) return decision
    return { kind: 'enter', messages: [...decision.messages, ...injections] }
  })
}

interface RankedSkill {
  readonly skill: SkillSummary
  readonly exactName: boolean
  readonly matchedTerms: number
  readonly nameMatches: number
  readonly nameTermCount: number
  readonly leadingNameMatch: boolean
  readonly whenToUseMatches: number
  readonly descriptionMatches: number
}

const ROUTING_TERM = /[\p{L}\p{N}]+/gu

/**
 * Rank model-invocable skill summaries against task keywords without loading any body.
 * @param skills - candidate summaries visible to the calling agent.
 * @param query - task text or concise model-authored keywords.
 * @returns matching summaries and scores in deterministic relevance order.
 */
function rankSkills(skills: readonly SkillSummary[], query: string): RankedSkill[] {
  const queryPhrase = routingPhrase(query)
  const queryTerms = new Set(queryPhrase.split(' ').filter(Boolean))
  if (queryTerms.size === 0) return []

  // Lexical metadata ranking stays local; add semantic retrieval only after measured routing misses.
  const ranked: RankedSkill[] = []
  for (const skill of skills) {
    const namePhrase = routingPhrase(skill.name)
    const nameTermList = namePhrase.split(' ')
    const nameTerms = new Set(nameTermList)
    const descriptionTerms = routingTerms(skill.description)
    const whenToUseTerms = routingTerms(skill.whenToUse ?? '')
    const allTerms = new Set([...nameTerms, ...descriptionTerms, ...whenToUseTerms])
    const matchedTerms = countMatches(queryTerms, allTerms)
    const exactName = ` ${queryPhrase} `.includes(` ${namePhrase} `)
    if (!exactName && matchedTerms === 0) continue
    ranked.push({
      skill,
      exactName,
      matchedTerms,
      nameMatches: countMatches(queryTerms, nameTerms),
      nameTermCount: nameTerms.size,
      leadingNameMatch: queryTerms.has(nameTermList[0] as string),
      whenToUseMatches: countMatches(queryTerms, whenToUseTerms),
      descriptionMatches: countMatches(queryTerms, descriptionTerms),
    })
  }
  ranked.sort((left, right) => Number(right.exactName) - Number(left.exactName)
    || right.matchedTerms - left.matchedTerms
    || right.nameMatches - left.nameMatches
    || right.whenToUseMatches - left.whenToUseMatches
    || right.descriptionMatches - left.descriptionMatches
    || Number(right.skill.aliasFor !== undefined) - Number(left.skill.aliasFor !== undefined)
    || compareText(left.skill.name, right.skill.name))
  const seen = new Set<string>()
  return ranked.filter(({ skill }) => {
    const canonical = skill.aliasFor ?? skill.name
    if (seen.has(canonical)) return false
    seen.add(canonical)
    return true
  })
}

function vetoesAutomaticSkill(task: string): boolean {
  // ponytail: lexical English/Vietnamese veto; use model classification if broader intent detection is needed.
  const text = task.normalize('NFKC')
  return /(?:^|[^\p{L}\p{N}])(?:no|not|never|without|avoid|skip|stop|cannot|\p{L}+n['’]t)(?=$|[^\p{L}\p{N}])/iu.test(text)
    || /(?:^|[^\p{L}\p{N}])(?:không|đừng|chớ|ngừng|khong|dung)(?=$|[^\p{L}\p{N}])/iu.test(text)
}

function automaticallySelectedSkill(ranked: readonly RankedSkill[]): SkillSummary | undefined {
  const best = ranked.find(isStrongAutomaticMatch)
  if (best === undefined) return undefined
  const next = ranked.slice(ranked.indexOf(best) + 1).find(isStrongAutomaticMatch)
  if (next !== undefined
    && next.exactName === best.exactName
    && next.matchedTerms === best.matchedTerms
    && next.nameMatches === best.nameMatches
    && next.whenToUseMatches === best.whenToUseMatches
    && next.descriptionMatches === best.descriptionMatches) return undefined
  return best.skill
}

function isStrongAutomaticMatch(candidate: RankedSkill): boolean {
  return candidate.exactName
    ? candidate.nameTermCount >= 2
    : candidate.matchedTerms >= 2 && candidate.nameMatches >= 2 && candidate.leadingNameMatch
}

function boundedSearchResult(
  ranked: readonly SkillSummary[],
  complete: boolean,
  maxResults: number,
  descriptionMaxLength: number,
  maxResultBytes: number,
): SkillSearchResult {
  const candidates = ranked.slice(0, maxResults).map((skill) => {
    const whenToUse = skill.whenToUse === undefined
      ? undefined
      : boundSearchText(skill.whenToUse, descriptionMaxLength)
    return {
      name: skill.name,
      description: boundSearchText(skill.description, descriptionMaxLength),
      ...whenToUse === undefined || whenToUse === '' ? {} : { whenToUse },
    }
  })
  const matches: SkillSearchMatch[] = []
  for (const candidate of candidates) {
    const nextMatches = [...matches, candidate]
    const next: SkillSearchResult = {
      complete,
      truncated: nextMatches.length < ranked.length,
      matches: nextMatches,
    }
    if (resultBytes(next) > maxResultBytes) break
    matches.push(candidate)
  }
  return {
    complete,
    truncated: matches.length < ranked.length,
    matches,
  }
}

function renderSkillSearchResult(result: SkillSearchResult): string {
  const candidates = result.matches.length === 0
    ? ['(none)']
    : result.matches.flatMap(match => [
      `- \`${match.name}\`: ${escapeText(match.description)}`,
      ...match.whenToUse === undefined ? [] : [`  Use when: ${escapeText(match.whenToUse)}`],
    ])
  return [
    `<skill_candidates complete="${result.complete}" truncated="${result.truncated}">`,
    ...candidates,
    '</skill_candidates>',
    ...result.complete ? [] : ['Discovery was incomplete; an empty result does not prove that no matching skill exists.'],
    'Choose zero or one candidate. Call `skill` only for the best match; load another only when the task clearly requires an independent skill.',
  ].join('\n')
}

function minimumSearchResultBytes(): number {
  return Math.max(...[true, false].flatMap(complete => [true, false].map(truncated => resultBytes({
    complete,
    truncated,
    matches: [],
  }))))
}

function resultBytes(result: SkillSearchResult): number {
  return Buffer.byteLength(renderSkillSearchResult(result), 'utf8')
}

function routingPhrase(value: string): string {
  return (value.normalize('NFKD').replaceAll(/\p{M}/gu, '').toLowerCase().match(ROUTING_TERM) ?? []).join(' ')
}

function routingTerms(value: string): ReadonlySet<string> {
  return new Set(routingPhrase(value).split(' ').filter(Boolean))
}

function countMatches(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0
  for (const value of left) {
    if (right.has(value)) count += 1
  }
  return count
}

function directUserText(messages: readonly UserMessage[]): string {
  return messages.flatMap(message => (message.source as { kind?: unknown }).kind === 'user'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : []).join('\n').trim()
}

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

/** Normalize and length-bound one model-visible summary field. */
function boundSearchText(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
