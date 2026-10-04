/** Native Kiro CodeWhisperer requests and AWS event-stream projection. */
import { randomUUID } from 'node:crypto'
import { EventStreamCodec } from '@smithy/core/event-streams'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { CallId, LlmAdapter, LlmError, supportsConversation, type ContentBlock, type GenerateOptions, type LlmDiscoveredModel,
  type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@hydraharness/harness-llm'
import type { AccountPool } from './accounts.ts'
import type { AccountProviderProfile } from './config.ts'
import { kiroIdentity, refreshNativeAccount } from './native-login.ts'
import { streamAccounts } from './adapter.ts'
import { accountJson } from './json-response.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '@hydraharness/harness-llm-pi-ai'
import { idleWatchdog, timeoutOf } from '@hydraharness/harness-timeout'

type Json = Record<string, unknown>

function object(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LlmError('Kiro returned an invalid event.', 'MALFORMED_RESPONSE')
  return value as Json
}

function contentText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'reasoning' || block.type === 'tool-call' || block.type === 'tool-result') return ''
    throw new LlmError(`Kiro account transport does not accept ${block.type} content.`, 'UNSUPPORTED_CONTENT')
  }).filter(Boolean).join('\n')
}

/**
 * Resolve one account's grant and refresh under the pool's write lock.
 * @param pool - native account pool.
 * @param provider - credential protocol.
 * @param id - request-local account identity.
 * @param signal - cancellation for refresh and commit.
 * @returns the selected native OAuth credential.
 */
export async function nativeCredential(pool: AccountPool, provider: 'cursor' | 'kiro', id: string, signal: AbortSignal): Promise<OAuthCredential> {
  return pool.withAccount(id, async () => {
    let selected!: OAuthCredential
    await pool.credentials.modify(provider, async (current) => {
      signal.throwIfAborted()
      if (current?.type !== 'oauth') throw new LlmError(`${provider} account has no OAuth grant.`, 'MISSING_CREDENTIAL')
      if (current.expires > Date.now() + 30_000) { selected = current; return undefined }
      selected = await refreshNativeAccount(provider, current, signal)
      signal.throwIfAborted()
      return selected
    })
    // The credential modifier resolves after its callback; absent grants reject inside that callback.
    return selected
  })
}

function endpoint(profile: AccountProviderProfile): URL {
  const url = new URL(profile.endpoint ?? `https://q.${kiroIdentity(profile).region}.amazonaws.com`)
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new LlmError('Kiro endpoint must use HTTPS or loopback HTTP without credentials, query, or fragment.', 'INVALID_ENDPOINT')
  }
  return url
}

function userMessage(options: GenerateOptions, blocks: readonly ContentBlock[]): Json {
  const results = blocks.flatMap(block => block.type === 'tool-result' ? [{ toolUseId: block.toolCallId,
    content: [{ text: contentText(block.content) }], status: block.isError === true ? 'error' : 'success' }] : [])
  return { content: contentText(blocks), modelId: options.model, origin: 'AI_EDITOR',
    ...results.length === 0 ? {} : { userInputMessageContext: { toolResults: results } } }
}

/**
 * Build Kiro history with Hydra tools and their durable results.
 * @param options - model-visible system text, messages, and tool schemas.
 * @returns the native conversation request, retaining exact model ids.
 */
export function buildKiroRequest(options: GenerateOptions): Json {
  const history: Json[] = []
  let pending: ContentBlock[] = []
  let system = options.system ?? ''
  const input = (): Json => {
    const message = userMessage(options, pending)
    const content = [system, message['content']].filter(Boolean).join('\n\n')
    // Kiro requires nonempty user text even when the message carries only tool results.
    message['content'] = content || ' '
    system = ''
    return message
  }
  const flush = (): void => { if (pending.length > 0) { history.push({ userInputMessage: input() }); pending = [] } }
  for (const message of options.messages) {
    if (message.role === 'user') { pending.push(...message.content); continue }
    flush()
    const calls = message.content.flatMap(block => block.type === 'tool-call'
      ? [{ toolUseId: block.id, name: block.name, input: JSON.parse(block.arguments) as unknown }] : [])
    history.push({ assistantResponseMessage: { content: contentText(message.content), ...calls.length === 0 ? {} : { toolUses: calls } } })
  }
  if (pending.length === 0 && system === '') throw new LlmError('Kiro requires a current user message or tool result.', 'INVALID_REQUEST')
  const current = input()
  const tools = options.tools?.map(tool => ({ toolSpecification: {
    name: tool.name, description: tool.description, inputSchema: { json: tool.parameters },
  } }))
  if (tools !== undefined && tools.length > 0) current['userInputMessageContext'] = { ...object(current['userInputMessageContext'] ?? {}), tools }
  return { conversationState: { conversationId: randomUUID(), chatTriggerType: 'MANUAL',
    currentMessage: { userInputMessage: current }, ...history.length === 0 ? {} : { history } } }
}

async function* events(response: Response, upstream: AbortSignal, idleMs: number): AsyncGenerator<{ type: string; payload: Json }> {
  using watchdog = idleWatchdog(upstream, idleMs, 'KIRO_STREAM_IDLE_TIMEOUT')
  const signal = watchdog.signal
  if (response.body === null) throw new LlmError('Kiro stream has no body.', 'MALFORMED_RESPONSE')
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const codec = new EventStreamCodec(decoder.decode.bind(decoder), encoder.encode.bind(encoder))
  const reader = response.body.getReader()
  let buffer = new Uint8Array()
  const abort = (): void => { void reader.cancel().catch(() => { /* Cancellation races the stream's normal close. */ }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const read = await watchdog.next<Uint8Array>({ next: async () => {
        const item = await reader.read()
        return item.done ? { done: true, value: undefined } : { done: false, value: item.value }
      } })
      signal.throwIfAborted()
      if (read.done) break
      const combined = new Uint8Array(buffer.length + read.value.length)
      combined.set(buffer); combined.set(read.value, buffer.length); buffer = combined
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0)
        if (length < 16 || length > 16 * 1024 * 1024) throw new LlmError('Kiro returned an invalid event length.', 'MALFORMED_RESPONSE')
        if (buffer.length < length) break
        const frame = codec.decode(buffer.slice(0, length))
        buffer = buffer.slice(length)
        const type = frame.headers[':event-type']?.value
        if (frame.headers[':message-type']?.value === 'exception' || frame.headers[':message-type']?.value === 'error') throw new LlmError('Kiro returned a provider error event.', 'TRANSPORT')
        if (typeof type !== 'string') throw new LlmError('Kiro returned an event without a type.', 'MALFORMED_RESPONSE')
        let payload: unknown
        try { payload = JSON.parse(new TextDecoder().decode(frame.body)) } catch { throw new LlmError('Kiro returned invalid event JSON.', 'MALFORMED_RESPONSE') }
        yield { type, payload: object(payload) }
      }
    }
    if (buffer.length > 0) throw new LlmError('Kiro stream ended with a partial event.', 'MALFORMED_RESPONSE')
  } catch (error: unknown) {
    if (timeoutOf(signal, 'KIRO_STREAM_IDLE_TIMEOUT') !== undefined) throw new LlmError(`Kiro stream idle timeout after ${idleMs}ms.`, 'TIMEOUT', { cause: error })
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => { /* Provider failure or abort may already have closed the reader. */ })
    reader.releaseLock()
  }
}

/** Account-bound Kiro catalog and native text/tool streams. */
export class KiroAccountAdapter extends LlmAdapter {
  constructor(private readonly pool: AccountPool, private readonly profile: AccountProviderProfile) { super() }

  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Kiro' } }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = this.profile.models ?? [{ id: 'auto', name: 'Auto' }]
    return Promise.resolve(models.map(model => ({ provider, id: model.id, name: model.name ?? model.id, inputModalities: ['text'],
      ...model.endpoints === undefined || model.endpoints.length === 0 ? {} : { endpoints: [...model.endpoints] } })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.profile.models?.find(candidate => candidate.id === model)
    return Promise.resolve({ provider, id: model, name: entry?.name ?? model, inputModalities: ['text'],
      ...entry?.endpoints === undefined || entry.endpoints.length === 0 ? {} : { endpoints: [...entry.endpoints] },
      context: { contextWindow: entry?.contextWindow ?? this.profile.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW } })
  }

  /**
   * Fetch the signed-in account's native model catalog.
   * @param signal - optional catalog cancellation.
   * @returns detached model ids from CodeWhisperer.
   */
  async discoverModels(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    const bounded = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(this.profile.timeoutMs ?? 30_000)])
    const account = (await this.pool.accounts.list())[0]
    if (account === undefined) throw new LlmError('Kiro has no connected account.', 'MISSING_CREDENTIAL')
    const credential = await nativeCredential(this.pool, 'kiro', account.id, bounded)
    const url = new URL(`${endpoint(this.profile).href.replace(/\/+$/, '')}/ListAvailableModels?origin=AI_EDITOR`)
    const profileArn = this.profile.profileArn ?? credential['profileArn']
    if (typeof profileArn === 'string' && profileArn !== '') url.searchParams.set('profileArn', profileArn)
    const result = new Map<string, LlmDiscoveredModel>()
    const cursors = new Set<string>()
    for (;;) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${credential.access}` }, signal: bounded, redirect: 'error' })
      if (!response.ok) { await response.body?.cancel(); throw new LlmError(`Kiro model discovery failed (HTTP ${response.status}).`, 'DISCOVERY_FAILED', { status: response.status }) }
      const data = await accountJson(response, bounded)
      if (!Array.isArray(data['models'])) throw new LlmError('Kiro model listing has no models.', 'DISCOVERY_FAILED')
      for (const entry of data['models'] as unknown[]) {
        const model = object(entry)
        if (typeof model['modelId'] !== 'string' || model['modelId'] === '') throw new LlmError('Kiro returned an invalid model id.', 'DISCOVERY_FAILED')
        result.set(model['modelId'], { id: model['modelId'], ...typeof model['modelName'] === 'string' ? { name: model['modelName'] } : {} })
      }
      const cursor = data['nextToken']
      if (cursor === undefined || cursor === '') return [...result.values()]
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new LlmError('Kiro returned invalid model pagination.', 'DISCOVERY_FAILED')
      cursors.add(cursor); url.searchParams.set('nextToken', cursor)
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const endpoints = this.profile.models?.find(model => model.id === options.model)?.endpoints
    if (!supportsConversation(endpoints?.length === 0 ? undefined : endpoints)) throw new LlmError(`Kiro model "${options.model}" does not support conversation.`, 'UNSUPPORTED_MODEL_ENDPOINT')
    if (options.stop !== undefined || options.temperature !== undefined || options.maxTokens !== undefined || options.reasoningEffort !== undefined) throw new LlmError('Kiro transport does not support request-level generation controls.', 'UNSUPPORTED_OPTION')
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(this.profile.timeoutMs ?? 300_000)])
    const body = JSON.stringify(buildKiroRequest(options))
    const url = `${endpoint(this.profile).href.replace(/\/+$/, '')}/generateAssistantResponse`
    const pool = this.pool
    const profile = this.profile
    yield* streamAccounts({ ...options, signal }, 'kiro', pool, async function* (id) {
      const credential = await nativeCredential(pool, 'kiro', id, signal)
      const profileArn = profile.profileArn ?? credential['profileArn']
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${credential.access}`, 'Content-Type': 'application/json', 'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse' },
        body: typeof profileArn === 'string' && profileArn !== '' ? JSON.stringify({ ...JSON.parse(body) as Json, profileArn }) : body })
      if (!response.ok) { await response.body?.cancel(); throw new LlmError(`Kiro generation failed (HTTP ${response.status}).`, 'TRANSPORT', { status: response.status }) }
      let text = ''
      let textOpen = false
      let sawOutput = false
      let index = 0
      const tools = new Map<string, { index: number; name: string; args: string }>()
      for await (const event of events(response, signal, profile.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS)) {
        if (event.type === 'assistantResponseEvent') {
          const delta = event.payload['content']
          if (typeof delta !== 'string') throw new LlmError('Kiro returned invalid text.', 'MALFORMED_RESPONSE')
          if (delta === '') continue
          sawOutput = true
          if (!textOpen) { textOpen = true; yield { type: 'block-start', index, blockType: 'text' } }
          text += delta
          yield { type: 'text-delta', index, text: delta }
        } else if (event.type === 'toolUseEvent') {
          const toolId = event.payload['toolUseId']
          if (typeof toolId !== 'string' || toolId === '') throw new LlmError('Kiro returned an invalid tool id.', 'MALFORMED_RESPONSE')
          let tool = tools.get(toolId)
          if (tool === undefined) {
            if (typeof event.payload['name'] !== 'string' || event.payload['name'] === '') throw new LlmError('Kiro returned an invalid tool name.', 'MALFORMED_RESPONSE')
            if (textOpen) { yield { type: 'block-end', index, block: { type: 'text', text } }; text = ''; textOpen = false; index++ }
            tool = { index: index++, name: event.payload['name'], args: '' }; tools.set(toolId, tool)
            yield { type: 'block-start', index: tool.index, blockType: 'tool-call' }
          }
          const raw = event.payload['input']
          sawOutput = true
          const delta = raw === undefined ? '' : typeof raw === 'string' ? raw : JSON.stringify(object(raw))
          tool.args += delta
          yield { type: 'tool-call-delta', index: tool.index, id: CallId(toolId), name: tool.name, argumentsDelta: delta }
        }
      }
      if (!sawOutput) throw new LlmError('Kiro returned no text or tool calls.', 'EMPTY_RESPONSE')
      if (textOpen) yield { type: 'block-end', index, block: { type: 'text', text } }
      for (const [id, tool] of tools) {
        let argumentsJson: unknown
        try { argumentsJson = JSON.parse(tool.args || '{}') } catch { throw new LlmError('Kiro tool arguments are incomplete.', 'MALFORMED_RESPONSE') }
        object(argumentsJson)
        yield { type: 'block-end', index: tool.index, block: { type: 'tool-call', id: CallId(id), name: tool.name, arguments: tool.args || '{}' } }
      }
      yield { type: 'finish', reason: { kind: tools.size > 0 ? 'tool-calls' : 'stop' } }
    })
  }
}
