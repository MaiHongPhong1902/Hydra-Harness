/**
 * Direct Google Cloud Code Assist transport used by the Antigravity route.
 *
 * This is a small Gemini-compatible adapter rather than a proxy. It keeps the
 * Harness message vocabulary at the edge, sends one native SSE request, and
 * exposes the provider's text, reasoning, tool, usage, and finish events as
 * {@link StreamChunk}s.
 *
 * @module hydra-llm-account-auth/antigravity
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, type ContentBlock, type FinishReason, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ReplayEnvelope, type StreamChunk, type TokenUsage, type ToolSchema } from '@hydra/harness-llm'
import { idleWatchdog, timeoutOf } from '@hydra/harness-timeout'
import type { AttachmentStore } from '@hydra/harness-attachment'
import type { Message } from '@hydra/harness-llm/message'
import {
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_API_ENDPOINT,
  ANTIGRAVITY_DAILY_API_ENDPOINT,
  ANTIGRAVITY_USER_AGENT,
  type AntigravityCredentials,
  type AntigravityFetch,
  antigravityRequestId,
} from './antigravity-oauth.ts'

/** Provider model request vocabulary. Kept open for future Cloud Code Assist fields. */
export interface AntigravityRequest {
  project: string
  model: string
  request: AntigravityGeminiRequest
  requestType: 'agent'
  userAgent: 'antigravity'
  requestId: string
}

/** Gemini request body nested inside the Cloud Code Assist envelope. */
export interface AntigravityGeminiRequest {
  contents: AntigravityContent[]
  sessionId?: string
  systemInstruction?: AntigravityContent
  generationConfig?: AntigravityGenerationConfig
  tools?: AntigravityTool[]
}

/** One Gemini role turn and its ordered parts. */
export interface AntigravityContent {
  role: 'user' | 'model'
  parts: AntigravityPart[]
}

/** One Gemini text, image, function, or function-response part. */
export interface AntigravityPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, unknown>; id?: string }
  functionResponse?: {
    name: string
    response: Record<string, unknown>
    id?: string
    parts?: AntigravityPart[]
  }
}

/** Supported generation controls sent through Cloud Code Assist. */
export interface AntigravityGenerationConfig {
  temperature?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  thinkingConfig?: { includeThoughts: boolean }
}

/** One native function declaration. */
export interface AntigravityTool {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

/** Optional request transport controls. */
export interface AntigravityTransportOptions {
  /** Cloud Code Assist endpoint; omission uses the native endpoint fallback list. */
  endpoint?: string
  /** Durable image resolver for image blocks in the request history. */
  attachments?: AttachmentStore
  /** Override the request id generator for deterministic tests. */
  requestId?: string
  /** Maximum idle interval while one provider stream read is outstanding. */
  streamIdleTimeoutMs?: number
}

/** A model advertised by the account's current Cloud Code Assist catalog. */
export interface AntigravityDiscoveredModel {
  /** Runtime model id accepted by `streamGenerateContent`. */
  id: string
  /** Provider display name, when advertised. */
  name: string
  /** Combined context capacity, when advertised. */
  contextWindow?: number
  /** Maximum output token capacity, when advertised. */
  maxTokens?: number
  /** Whether the model accepts image input. */
  supportsImages: boolean
  /** Whether the model exposes thinking output. */
  supportsThinking: boolean
  /** Provider marks internal models; callers normally hide these. */
  internal: boolean
}

/** Options for fetching the per-account Antigravity model catalog. */
export interface AntigravityDiscoveryOptions {
  /** Current account bearer token. */
  accessToken: string
  /** Cloud Code Assist project sent to the catalog endpoint when known. */
  projectId?: string
  /** Fetch implementation used by the host or a fixture. */
  fetch?: AntigravityFetch
  /** Request cancellation. */
  signal?: AbortSignal
  /** Override the native daily catalog endpoint. */
  endpoint?: string
}

/** Generate options with the optional image resolver accepted by this adapter. */
export type AntigravityGenerateOptions = GenerateOptions & {
  attachments?: AttachmentStore
  endpoint?: string
}

/** Replay metadata retained per emitted provider block. */
export interface AntigravityBlockReplay {
  thoughtSignature?: string
}

/** Provider response metadata retained in the terminal replay envelope. */
export interface AntigravityResponseReplay {
  responseId?: string
  finishReason?: string
}

/** User-visible provider model descriptor accepted by the adapter. */
export interface AntigravityModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** Credential resolver and catalog settings for {@link AntigravityAdapter}. */
export interface AntigravityAdapterOptions {
  /** Resolve one request's selected account; the value is never cached by the adapter. */
  resolveCredentials: () => Promise<AntigravityCredentials | undefined>
  /** Optional catalog entries. Empty means the route remains request-capable but undiscoverable. */
  models?: readonly AntigravityModelProfile[]
  /** Optional Cloud Code Assist endpoint. */
  endpoint?: string
  /** Fetch implementation for network tests or a host transport. */
  fetch?: AntigravityFetch
  /** Durable image resolver. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Maximum idle interval while one provider stream read is outstanding. */
  streamIdleTimeoutMs?: number
}

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

const ANTIGRAVITY_SANDBOX_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const ANTIGRAVITY_GEMINI_THOUGHT_SIGNATURE_BYPASS = 'skip_thought_signature_validator'

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function httpStatusValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

type JsonRecord = Record<string, unknown>

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : '').join('')
}

/** Whether a provider thought signature is a complete padded base64 value. */
function isValidAntigravityThoughtSignature(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

/** Normalize IDs for provider models that reject punctuation or long IDs. */
function normalizeAntigravityToolCallId(id: string, model: string): string {
  if (!/(?:claude|gpt-oss)/i.test(model)) return id
  const normalized = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return normalized.length > 0 ? normalized : 'call'
}

function antigravityNeedsThoughtSignatureBypass(model: string): boolean {
  return !/claude/i.test(model) && /(?:gemini|flash|agent)/i.test(model)
}

function externalToolName(name: string): string {
  return name === 'read_file' || name === 'write_file' || name === 'execute_code'
    ? `external_${name}`
    : name
}

function localToolName(name: string): string {
  return name.startsWith('external_') ? name.slice('external_'.length) : name
}

interface SerializationContext {
  readonly model: string
  readonly attachments?: AttachmentStore
  readonly signal?: AbortSignal
  readonly callNames: Map<string, string>
  readonly normalizedCalls: Map<string, string>
}

function signatureFromReplay(message: Message, blockIndex: number): string | undefined {
  if (message.role !== 'assistant' || message.source.kind !== 'model') return undefined
  if (message.source.provider !== 'antigravity' && message.source.provider !== 'google-antigravity') return undefined
  const replay = objectRecord(message.source.replayState)
  if (!Array.isArray(replay?.blocks)) return undefined
  const entry = objectRecord(replay.blocks[blockIndex])
  const signature = entry?.thoughtSignature ?? entry?.signature
  return isValidAntigravityThoughtSignature(signature) ? signature : undefined
}

async function imagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  context: SerializationContext,
): Promise<AntigravityPart> {
  if (context.attachments === undefined) {
    throw new LlmError('Antigravity image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  if (context.signal?.aborted) {
    throw new LlmError('Antigravity image attachment read was aborted', 'ABORTED')
  }
  try {
    const image = await context.attachments.readImage(block.attachment, context.signal)
    return {
      inlineData: {
        mimeType: image.ref.mediaType,
        data: Buffer.from(image.data).toString('base64'),
      },
    }
  } catch {
    if (context.signal?.aborted) {
      throw new LlmError('Antigravity image attachment read was aborted', 'ABORTED')
    }
    throw new LlmError('Antigravity image attachment could not be read', 'UNSUPPORTED_CONTENT')
  }
}

async function contentParts(
  blocks: readonly ContentBlock[],
  context: SerializationContext,
): Promise<AntigravityPart[]> {
  const parts: AntigravityPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ text: block.text })
        break
      case 'image':
        parts.push(await imagePart(block, context))
        break
      case 'tool-result': {
        const id = String(block.toolCallId)
        const name = context.callNames.get(id) ?? 'unknown'
        const normalizedId = context.normalizedCalls.get(id) ?? normalizeAntigravityToolCallId(id, context.model)
        const nested = await contentParts(block.content, context)
        const text = nested.filter(part => part.text !== undefined).map(part => part.text).join('')
        const images = nested.filter(part => part.inlineData !== undefined)
        const response: Record<string, unknown> = block.isError
          ? { error: text || 'Tool execution failed' }
          : { output: text }
        parts.push({
          functionResponse: {
            name,
            response,
            id: normalizedId,
            ...(images.length > 0 ? { parts: images } : {}),
          },
        })
        break
      }
      default:
        // Reasoning and assistant-only blocks have no user-content equivalent.
        break
    }
  }
  return parts
}

/** Serialize Harness messages to Gemini contents, resolving durable images.
 * @param messages - Ordered Harness conversation messages.
 * @param model - Native model id used for tool-call id rules.
 * @param attachments - Optional durable image attachment service.
 * @param signal - Optional cancellation signal for attachment reads.
 * @returns Gemini conversation contents.
 */
export async function serializeAntigravityMessages(
  messages: readonly Message[],
  model: string,
  attachments?: AttachmentStore,
  signal?: AbortSignal,
): Promise<AntigravityContent[]> {
  const context: SerializationContext = {
    model,
    ...(attachments === undefined ? {} : { attachments }),
    ...(signal === undefined ? {} : { signal }),
    callNames: new Map(),
    normalizedCalls: new Map(),
  }
  const contents: AntigravityContent[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      // System messages are carried by systemInstruction below; duplicating
      // them in contents changes the model-visible prompt.
      continue
    }
    if (message.role === 'assistant') {
      const parts: AntigravityPart[] = []
      let firstFunctionCall = true
      message.content.forEach((block, index) => {
        const signature = signatureFromReplay(message, index)
        if (block.type === 'text') {
          if (block.text.length > 0) parts.push({ text: block.text, ...(signature === undefined ? {} : { thoughtSignature: signature }) })
        } else if (block.type === 'reasoning') {
          if (block.text.length > 0) {
            parts.push({
              text: block.text,
              thought: true,
              ...(signature === undefined ? {} : { thoughtSignature: signature }),
            })
          }
        } else if (block.type === 'tool-call') {
          const originalId = String(block.id)
          const id = normalizeAntigravityToolCallId(originalId, model)
          context.callNames.set(originalId, externalToolName(block.name))
          context.normalizedCalls.set(originalId, id)
          let args: Record<string, unknown> = {}
          try {
            const parsed: unknown = JSON.parse(block.arguments)
            args = objectRecord(parsed) ?? {}
          } catch {
            // Gemini requires an object; malformed historical arguments are
            // represented as an empty object rather than crashing serialization.
          }
          const replaySignature = signature
            ?? (firstFunctionCall && antigravityNeedsThoughtSignatureBypass(model)
              ? ANTIGRAVITY_GEMINI_THOUGHT_SIGNATURE_BYPASS
              : undefined)
          firstFunctionCall = false
          parts.push({
            functionCall: {
              name: externalToolName(block.name),
              args,
              id,
            },
            ...(replaySignature === undefined ? {} : { thoughtSignature: replaySignature }),
          })
        }
      })
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    const parts = await contentParts(message.content, context)
    if (parts.length === 0) parts.push({ text: '' })
    // Gemini requires function responses in a user content turn.
    contents.push({ role: 'user', parts })
  }
  return contents
}

function systemInstruction(options: AntigravityGenerateOptions): AntigravityContent | undefined {
  const parts: AntigravityPart[] = []
  if (options.system !== undefined && options.system.length > 0) parts.push({ text: options.system })
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = flattenText(message.content)
    if (text.length > 0) parts.push({ text })
  }
  return parts.length === 0 ? undefined : { role: 'user', parts }
}

/**
 * Translate one tool-parameter schema into the shape Gemini's `Schema` takes.
 * The only keyword the two vocabularies disagree on is `const`, which the
 * harness emits for a literal value and Gemini has no field for at all — it
 * refuses the whole request over the unknown name. The rest of the enforced
 * subset is Gemini's own and passes through untouched.
 * @param node - one schema node from a tool's parameters.
 * @returns the same node in Gemini's vocabulary.
 */
function geminiParameters(node: unknown): Record<string, unknown> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return {}
  const { const: literal, properties, items, oneOf, ...rest } = node as Record<string, unknown>
  const converted: Record<string, unknown> = { ...rest }
  // Gemini has no `const`: an enum of one value says the same thing.
  if (literal !== undefined) converted.enum = [literal]
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    converted.properties = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>).map(([name, value]) => [name, geminiParameters(value)]),
    )
  }
  if (items !== undefined) {
    converted.items = Array.isArray(items) ? items.map(item => geminiParameters(item)) : geminiParameters(items)
  }
  if (Array.isArray(oneOf)) converted.oneOf = oneOf.map(branch => geminiParameters(branch))
  return converted
}

function toolDeclarations(tools: readonly ToolSchema[] | undefined): AntigravityTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map(tool => ({
      name: externalToolName(tool.name),
      description: tool.description,
      parameters: geminiParameters(tool.parameters),
    })),
  }]
}

/** Fetch the account's live Antigravity model catalog without exposing its token.
 * @param options - Access token, endpoint, project, and cancellation settings.
 * @returns Normalized model descriptors from the provider catalog.
 */
export async function discoverAntigravityModels(
  options: AntigravityDiscoveryOptions,
): Promise<AntigravityDiscoveredModel[]> {
  const access = stringValue(options.accessToken)
  if (access === undefined) throw new LlmError('Antigravity model discovery needs an access token', 'INVALID_CREDENTIAL')
  const fetchImplementation = options.fetch ?? fetch
  const endpoints = options.endpoint === undefined
    ? [ANTIGRAVITY_DAILY_API_ENDPOINT, ANTIGRAVITY_API_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]
    : [options.endpoint]
  const body = stringValue(options.projectId) === undefined
    ? '{}'
    : JSON.stringify({ project: stringValue(options.projectId) })
  let lastError: LlmError | undefined
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]?.replace(/\/+$/u, '')
    if (endpoint === undefined || endpoint.length === 0) continue
    let response: Response
    try {
      response = await fetchImplementation(
        `${endpoint}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${access}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': ANTIGRAVITY_USER_AGENT,
          },
          body,
          signal: options.signal ?? null,
        },
      )
    } catch {
      if (options.signal?.aborted) throw new LlmError('Antigravity model discovery was aborted', 'ABORTED')
      lastError = new LlmError('Antigravity model discovery request failed', 'TRANSPORT')
      if (index + 1 >= endpoints.length) throw lastError
      continue
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      const code = classifyStreamError(response.status, bodyText)
      lastError = new LlmError(
        `Antigravity model discovery failed with HTTP ${String(response.status)}`,
        code,
        { status: response.status },
      )
      if ((response.status !== 403 && response.status !== 404)
        || code === QUOTA_EXCEEDED_CODE
        || index + 1 >= endpoints.length) throw lastError
      continue
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new LlmError('Antigravity model discovery returned malformed JSON', 'MALFORMED_RESPONSE')
    }
    const models = objectRecord(objectRecord(payload)?.models)
    if (models === undefined) throw new LlmError('Antigravity model discovery returned no model catalog', 'MALFORMED_RESPONSE')
    return Object.entries(models)
      .flatMap(([id, raw]) => {
        const model = objectRecord(raw)
        if (model === undefined || id.length === 0) return []
        const displayName = stringValue(model.displayName) ?? id
        const mimeTypes = model.supportedMimeTypes
        const supportsImages = model.supportsImages === true
          || (Array.isArray(mimeTypes) && mimeTypes.some(mime => typeof mime === 'string' && mime.startsWith('image/')))
          || (objectRecord(mimeTypes) !== undefined && Object.keys(objectRecord(mimeTypes) ?? {}).some(mime => mime.startsWith('image/')))
        const contextWindow = numberValue(model.maxTokens)
        const maxTokens = numberValue(model.maxOutputTokens)
        return [{
          id,
          name: displayName,
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          supportsImages,
          supportsThinking: model.supportsThinking === true,
          internal: model.isInternal === true,
        }]
      })
      .sort((left, right) => left.id.localeCompare(right.id))
  }
  throw lastError ?? new LlmError('Antigravity model discovery has no endpoint', 'TRANSPORT')
}

/** Build the complete Cloud Code Assist request body.
 * @param options - Harness generation options and optional transport fields.
 * @param credentials - Credential fields needed to identify the Cloud project.
 * @param transport - Optional endpoint, attachment, and request-id overrides.
 * @returns A native Cloud Code Assist request envelope.
 */
export async function buildAntigravityRequest(
  options: AntigravityGenerateOptions,
  credentials: Pick<AntigravityCredentials, 'projectId'>,
  transport: AntigravityTransportOptions = {},
): Promise<AntigravityRequest> {
  const projectId = stringValue(credentials.projectId)
  if (projectId === undefined) throw new LlmError('Antigravity credentials are missing projectId', 'INVALID_CREDENTIAL')
  const contents = await serializeAntigravityMessages(
    options.messages,
    options.model,
    transport.attachments ?? options.attachments,
    options.signal,
  )
  const generationConfig: AntigravityGenerationConfig = {
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stopSequences: options.stop }),
    ...(options.purpose === 'session-title'
      || options.reasoningEffort === undefined || options.reasoningEffort === 'none'
      ? {}
      : { thinkingConfig: { includeThoughts: true } }),
  }
  const instruction = systemInstruction(options)
  const tools = toolDeclarations(options.tools)
  const request: AntigravityGeminiRequest = {
    contents,
    ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
    ...(instruction === undefined ? {} : { systemInstruction: instruction }),
    ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
    ...(tools === undefined ? {} : { tools }),
  }
  const requestId = transport.requestId
    ?? antigravityRequestId()
  return {
    project: projectId,
    model: options.model,
    request,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId,
  }
}

/** Parse an SSE byte stream with UTF-8, CRLF, multiline data, and cancellation support.
 * @param stream - Provider response body to decode and parse.
 * @param signal - Optional cancellation signal for the active reader.
 * @returns An async sequence of complete SSE data fields.
 */
export async function* parseAntigravitySse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let dataLines: string[] = []
  let completed = false
  let cancelled = false
  const dispatch = function* (): Generator<string> {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    yield data
  }
  const lines = function* (flush: boolean): Generator<string> {
    while (true) {
      const index = text.indexOf('\n')
      if (index < 0) break
      let line = text.slice(0, index)
      text = text.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      yield line
    }
    if (flush && text.length > 0) {
      const line = text
      text = ''
      yield line
    }
  }
  const process = function* (line: string): Generator<string> {
    if (line === '') {
      yield* dispatch()
    } else if (line.startsWith('data:')) {
      const value = line.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  const cancelReader = async (): Promise<void> => {
    if (cancelled) return
    cancelled = true
    await reader.cancel(signal?.reason).catch(() => undefined)
  }
  const abort = (): void => { void cancelReader() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (signal?.aborted) throw new LlmError('Antigravity stream was aborted', 'ABORTED')
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch {
        if (signal?.aborted) throw new LlmError('Antigravity stream was aborted', 'ABORTED')
        throw new LlmError('Antigravity SSE stream could not be read', 'TRANSPORT')
      }
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
      if (dataLines.length === 0 && text.startsWith('\uFEFF')) text = text.slice(1)
      for (const line of lines(false)) yield* process(line)
    }
    if (signal?.aborted) throw new LlmError('Antigravity stream was aborted', 'ABORTED')
    text += decoder.decode()
    const hadUnterminatedLine = text.length > 0
    for (const line of lines(true)) yield* process(line)
    if (hadUnterminatedLine) {
      throw new LlmError('Antigravity SSE stream ended before an event boundary', 'MALFORMED_RESPONSE')
    }
    // Cloud Code Assist occasionally closes after the final data line without
    // the blank separator required by SSE. Treat that complete line as the
    // final event; an actually unterminated line remains malformed above.
    yield* dispatch()
    completed = true
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!completed) await cancelReader()
    reader.releaseLock()
  }
}

function extractResponse(payload: JsonRecord): JsonRecord | undefined {
  return objectRecord(payload.response) ?? payload
}

function usageOf(raw: unknown): TokenUsage | undefined {
  const usage = objectRecord(raw)
  if (usage === undefined) return undefined
  const number = (key: string): number => {
    const value = usage[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }
  const prompt = number('promptTokenCount')
  const cached = number('cachedContentTokenCount')
  const thoughts = number('thoughtsTokenCount')
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: number('candidatesTokenCount') + thoughts,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
  }
}

function finishFor(raw: unknown, toolCalled: boolean, model: string): { reason: FinishReason; providerReason?: string } {
  const value = stringValue(raw)?.toUpperCase()
  if (toolCalled && (value === undefined || value === 'STOP' || value === 'TOOL_CALL' || value === 'TOOL_USE')) {
    return {
      reason: { kind: 'tool-calls' },
      ...(value === undefined ? {} : { providerReason: value }),
    }
  }
  switch (value) {
    case undefined:
    case 'STOP': return { reason: { kind: 'stop' }, ...(value === undefined ? {} : { providerReason: value }) }
    case 'MAX_TOKENS':
    case 'LENGTH': return { reason: { kind: 'max-tokens' }, providerReason: value }
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return {
        reason: { kind: 'error', failure: { code: value, message: `Antigravity blocked the response for ${value.toLowerCase()}` } },
        providerReason: value,
      }
    default:
      return {
        reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: `Antigravity model "${model}" stopped with ${value}` } },
        providerReason: value,
      }
  }
}

function classifyStreamError(status: number, message: string): string {
  if (/quota|exhaust|resource.?exhaust|usage.?limit/i.test(message)) return QUOTA_EXCEEDED_CODE
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 400 && status < 500) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return /timeout/i.test(message) ? 'TIMEOUT' : 'TRANSPORT'
}

async function errorResponse(response: Response): Promise<LlmError> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // Preserve the status classification when a failed body cannot be read.
  }
  return new LlmError(
    `Antigravity request failed with HTTP ${String(response.status)}`,
    classifyStreamError(response.status, body),
    { status: response.status },
  )
}

function streamEndpoints(options: AntigravityGenerateOptions, transport: AntigravityTransportOptions): string[] {
  const configured = transport.endpoint ?? options.endpoint
  if (configured !== undefined) return [configured.replace(/\/+$/u, '')]
  return [ANTIGRAVITY_DAILY_API_ENDPOINT, ANTIGRAVITY_API_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]
}

async function requestStream(
  options: AntigravityGenerateOptions,
  access: string,
  request: AntigravityRequest,
  fetchImplementation: AntigravityFetch,
  transport: AntigravityTransportOptions,
): Promise<Response> {
  let lastError: LlmError | undefined
  const endpoints = streamEndpoints(options, transport)
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]
    if (endpoint === undefined) continue
    let response: Response
    try {
      response = await fetchImplementation(
        `${endpoint}/${ANTIGRAVITY_API_VERSION}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${access}`,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'User-Agent': ANTIGRAVITY_USER_AGENT,
          },
          body: JSON.stringify(request),
          signal: options.signal ?? null,
        },
      )
    } catch {
      if (options.signal?.aborted) {
        throw new LlmError('Antigravity stream was aborted', 'ABORTED')
      }
      lastError = new LlmError('Antigravity stream request failed', 'TRANSPORT')
      if (index + 1 >= endpoints.length) throw lastError
      continue
    }
    if (response.ok) return response
    const error = await errorResponse(response)
    lastError = error
    // 403/404 are endpoint capability misses. Quota/auth failures should
    // reach the account selector instead of being hidden by a fallback.
    if ((response.status !== 403 && response.status !== 404)
      || error.code === QUOTA_EXCEEDED_CODE
      || index + 1 >= endpoints.length) throw error
  }
  throw lastError ?? new LlmError('Antigravity stream has no endpoint', 'TRANSPORT')
}

interface OpenBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning'
  text: string
  signature?: string
}

/** Stream one Antigravity request through native Cloud Code Assist SSE.
 * @param options - Harness generation options and optional transport fields.
 * @param credentials - Account credentials used for the provider request.
 * @param fetchImplementation - Fetch function used for the native request.
 * @param transport - Optional endpoint, attachment, and request-id overrides.
 * @returns An async sequence of Harness stream chunks.
 */
export async function* streamAntigravity(
  options: AntigravityGenerateOptions,
  credentials: AntigravityCredentials,
  fetchImplementation: AntigravityFetch = fetch,
  transport: AntigravityTransportOptions = {},
): AsyncGenerator<StreamChunk> {
  const access = stringValue(credentials.access)
  const projectId = stringValue(credentials.projectId)
  if (access === undefined || projectId === undefined) {
    throw new LlmError('Antigravity credentials are missing access or projectId', 'INVALID_CREDENTIAL')
  }
  const request = await buildAntigravityRequest(options, { projectId }, transport)
  const response = await requestStream(options, access, request, fetchImplementation, transport)
  if (response.body === null) throw new LlmError('Antigravity response did not include an SSE body', 'STREAM_CLOSED')

  let nextIndex = 0
  let active: OpenBlock | undefined
  const toolBlocks = new Map<string, { index: number; id: string; name: string; args: string; signature?: string }>()
  const replayBlocks: AntigravityBlockReplay[] = []
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let providerFinish: string | undefined
  let responseId: string | undefined
  let sawContent = false
  let sawTerminal = false

  const closeActive = function* (): Generator<StreamChunk> {
    if (active === undefined) return
    yield { type: 'block-end', index: active.index, block: active.type === 'text'
      ? { type: 'text', text: active.text }
      : { type: 'reasoning', text: active.text } }
    active = undefined
  }
  const consumer = new AbortController()
  const upstream = options.signal === undefined
    ? consumer.signal
    : AbortSignal.any([options.signal, consumer.signal])
  using watchdog = idleWatchdog(
    upstream,
    transport.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    STREAM_IDLE_TIMEOUT_CODE,
  )
  const events = parseAntigravitySse(response.body, watchdog.signal)[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await watchdog.next(events)
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Antigravity stream idle timeout after ${transport.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`,
          'TIMEOUT',
        )
      }
      if (next.done) {
        break
      }
      const event = next.value
      if (event === '[DONE]') {
        sawTerminal = true
        if (providerFinish === undefined) providerFinish = 'STOP'
        break
      }
      let payload: unknown
      try {
        payload = JSON.parse(event)
      } catch {
        throw new LlmError('Antigravity SSE event was not valid JSON', 'MALFORMED_RESPONSE')
      }
      const object = objectRecord(payload)
      if (object === undefined) throw new LlmError('Antigravity SSE event was not a JSON object', 'MALFORMED_RESPONSE')
      const topError = objectRecord(object.error)
      if (topError !== undefined) {
        const providerDetails = JSON.stringify(topError)
        const numericStatus = httpStatusValue(topError.code) ?? httpStatusValue(topError.status)
        const status = numericStatus === undefined
          ? /quota|exhaust|resource.?exhaust|rate.?limit/i.test(providerDetails) ? 429 : 500
          : numericStatus
        const code = classifyStreamError(status, providerDetails)
        throw new LlmError(`Antigravity provider request failed with HTTP ${String(status)}`, code, { status })
      }
      const data = extractResponse(object)
      if (data === undefined) continue
      responseId ??= stringValue(data.responseId)
      const metadata = usageOf(data.usageMetadata)
      if (metadata !== undefined) usage = metadata
      const candidates = Array.isArray(data.candidates) ? data.candidates : []
      const candidate = objectRecord(candidates[0])
      const content = objectRecord(candidate?.content)
      const parts = Array.isArray(content?.parts) ? content.parts : []
      for (const rawPart of parts) {
        const part = objectRecord(rawPart)
        if (part === undefined) continue
        const text = typeof part.text === 'string' ? part.text : undefined
        const thinking = part.thought === true
        if (text !== undefined) {
          if (text.length === 0) continue
          const type = thinking ? 'reasoning' : 'text'
          if (active === undefined || active.type !== type) {
            yield* closeActive()
            active = { index: nextIndex, type, text: '', ...(isValidAntigravityThoughtSignature(part.thoughtSignature) ? { signature: part.thoughtSignature } : {}) }
            nextIndex += 1
            replayBlocks.push(active.signature === undefined ? {} : { thoughtSignature: active.signature })
            yield { type: 'block-start', index: active.index, blockType: active.type }
          } else if (active.signature === undefined && isValidAntigravityThoughtSignature(part.thoughtSignature)) {
            active.signature = part.thoughtSignature
            replayBlocks[active.index] = { thoughtSignature: part.thoughtSignature }
          }
          active.text += text
          sawContent = true
          yield active.type === 'text'
            ? { type: 'text-delta', index: active.index, text }
            : { type: 'reasoning-delta', index: active.index, text }
        }
        const functionCall = objectRecord(part.functionCall)
        if (functionCall !== undefined) {
          yield* closeActive()
          const rawId = stringValue(functionCall.id) ?? `call-${String(nextIndex)}`
          const id = normalizeAntigravityToolCallId(rawId, options.model)
          const name = localToolName(stringValue(functionCall.name) ?? '')
          const key = id
          let tool = toolBlocks.get(key)
          if (tool === undefined) {
            tool = { index: nextIndex, id, name, args: '', ...(isValidAntigravityThoughtSignature(part.thoughtSignature) ? { signature: part.thoughtSignature } : {}) }
            toolBlocks.set(key, tool)
            nextIndex += 1
            replayBlocks.push(tool.signature === undefined ? {} : { thoughtSignature: tool.signature })
            yield { type: 'block-start', index: tool.index, blockType: 'tool-call' }
          } else if (tool.signature === undefined && isValidAntigravityThoughtSignature(part.thoughtSignature)) {
            tool.signature = part.thoughtSignature
            replayBlocks[tool.index] = { thoughtSignature: part.thoughtSignature }
          }
          const args = functionCall.args
          const wireArgs = typeof args === 'string' ? args : JSON.stringify(args ?? {})
          let delta = ''
          if (wireArgs !== tool.args) {
            if (wireArgs.startsWith(tool.args)) {
              delta = wireArgs.slice(tool.args.length)
              tool.args = wireArgs
            } else {
              // Gemini normally repeats the complete argument object. If a
              // later snapshot is not a prefix, replace the previous one
              // instead of concatenating two JSON documents.
              delta = wireArgs
              tool.args = wireArgs
            }
          }
          sawContent = true
          if (delta.length > 0) {
            yield { type: 'tool-call-delta', index: tool.index, id: CallId(tool.id), name: tool.name, argumentsDelta: delta }
          }
        }
      }
      const candidateFinish = stringValue(candidate?.finishReason)
      if (candidateFinish !== undefined) {
        providerFinish = candidateFinish
        sawTerminal = true
      }
    }
  } catch (error: unknown) {
    if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
      throw new LlmError(
        `Antigravity stream idle timeout after ${transport.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`,
        'TIMEOUT',
        { cause: error },
      )
    }
    if (options.signal?.aborted) {
      throw new LlmError('Antigravity stream was aborted', 'ABORTED', { cause: error })
    }
    throw error
  } finally {
    consumer.abort('Antigravity stream consumer stopped')
    try { await events.return(undefined) } catch { /* abort owns transport teardown */ }
    // parseAntigravitySse owns reader cancellation on early generator return.
  }
  yield* closeActive()
  for (const tool of toolBlocks.values()) {
    yield {
      type: 'block-end',
      index: tool.index,
      block: { type: 'tool-call', id: CallId(tool.id), name: tool.name, arguments: tool.args || '{}' },
    }
  }
  if (!sawTerminal && (sawContent || usage.inputTokens > 0 || usage.outputTokens > 0)) {
    // Some Cloud Code Assist streams close cleanly after usage without a
    // candidate finishReason or [DONE]. Preserve the completed response.
    sawTerminal = true
    providerFinish ??= toolBlocks.size > 0 ? 'TOOL_CALL' : 'STOP'
  }
  if (!sawTerminal) throw new LlmError('Antigravity SSE stream ended without a finish reason', 'STREAM_CLOSED')
  yield { type: 'usage', usage }
  const finish = finishFor(providerFinish, toolBlocks.size > 0, options.model)
  if (finish.reason.kind === 'stop' && !sawContent) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE, message: `Antigravity model "${options.model}" returned no content` } },
    }
    return
  }
  const replay: ReplayEnvelope | undefined = replayBlocks.length === 0
    ? undefined
    : {
      response: {
        ...(responseId === undefined ? {} : { responseId }),
        ...(finish.providerReason === undefined ? {} : { finishReason: finish.providerReason }),
      } satisfies AntigravityResponseReplay,
      blocks: replayBlocks,
    }
  yield { type: 'finish', reason: finish.reason, ...(replay === undefined ? {} : { replayState: replay }) }
}

/** A Harness adapter around the direct Antigravity transport. */
export class AntigravityAdapter extends LlmAdapter {
  constructor(private readonly config: AntigravityAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Antigravity' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve((this.config.models ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = this.config.models?.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.contextWindow === undefined ? {} : { context: { contextWindow: known.contextWindow } }),
      ...(known?.maxTokens === undefined ? {} : { defaultMaxTokens: known.maxTokens }),
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credentials = await this.config.resolveCredentials()
    if (credentials === undefined) {
      throw new LlmError('Google Antigravity has no connected account', 'MISSING_CREDENTIAL')
    }
    yield* streamAntigravity(
      options,
      credentials,
      this.config.fetch,
      {
        ...(this.config.endpoint === undefined ? {} : { endpoint: this.config.endpoint }),
        ...(this.config.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: this.config.streamIdleTimeoutMs }),
        ...(() => {
          const attachments = this.config.resolveAttachments?.()
          return attachments === undefined ? {} : { attachments }
        })(),
      },
    )
  }
}
