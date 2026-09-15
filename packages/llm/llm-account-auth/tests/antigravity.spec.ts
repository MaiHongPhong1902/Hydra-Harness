import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@hydra/harness-attachment'
import { CallId, MessageId, ReasoningEffortId, errorChain } from '@hydra/harness-llm'
import type { ContentBlock, GenerateOptions, Message } from '@hydra/harness-llm'
import { SessionId } from '@hydra/harness-session'
import {
  buildAntigravityRequest,
  discoverAntigravityModels,
  parseAntigravitySse,
  serializeAntigravityMessages,
  streamAntigravity,
} from '../src/antigravity.ts'
import type { AntigravityCredentials } from '../src/antigravity-oauth.ts'

const credentials: AntigravityCredentials = {
  access: 'access-token-fixture',
  refresh: 'refresh-token-fixture',
  expires: Date.now() + 60_000,
  projectId: 'project-fixture',
  email: 'user@example.test',
}

function message(id: string, role: Message['role'], content: ContentBlock[], source: Message['source']): Message {
  return { id: MessageId(id), role, content, source }
}

function user(id: string, content: ContentBlock[]): Message {
  return message(id, 'user', content, { kind: 'user' })
}

function assistant(id: string, content: ContentBlock[], replayState?: unknown): Message {
  return message(id, 'assistant', content, {
    kind: 'model',
    provider: 'antigravity',
    model: 'gemini-test',
    ...(replayState === undefined ? {} : { replayState }),
  })
}

function options(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-test',
    messages,
    ...extra,
  }
}

function sseBody(events: readonly string[], splitAt?: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${event}\n\n`).join(''))
  const split = splitAt ?? Math.max(1, Math.floor(bytes.length / 2))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split))
      controller.enqueue(bytes.slice(split))
      controller.close()
    },
  })
}

function sseBodyWithoutFinalBlank(event: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${event}\n`))
      controller.close()
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Antigravity request serialization', () => {
  it('keeps caller context, maps tool calls/results, images, and session metadata', async () => {
    const toolCall = {
      type: 'tool-call' as const,
      id: CallId('call|long-id'),
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    }
    const messages = [
      user('u1', [{ type: 'text', text: 'Inspect this file.' }]),
      assistant('a1', [toolCall], {
        blocks: [{ thoughtSignature: 'YWJjZA==' }],
      }),
      user('u2', [{
        type: 'tool-result',
        toolCallId: toolCall.id,
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      }]),
    ]

    const serialized = await serializeAntigravityMessages(messages, 'claude-test')
    expect(serialized).toEqual([
      { role: 'user', parts: [{ text: 'Inspect this file.' }] },
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'external_read_file',
            args: { path: 'README.md' },
            id: 'call_long-id',
          },
          thoughtSignature: 'YWJjZA==',
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'external_read_file',
            response: { output: 'file contents' },
            id: 'call_long-id',
          },
        }],
      },
    ])

    const request = await buildAntigravityRequest(options(messages, {
      system: 'Follow the project instructions.',
      sessionId: SessionId('session-fixture'),
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
      maxTokens: 200,
      stop: ['END'],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    }), credentials)
    expect(request.project).toBe('project-fixture')
    expect(request.request.sessionId).toBe('session-fixture')
    expect(request.request.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'Follow the project instructions.' }],
    })
    expect(request.request.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 200,
      stopSequences: ['END'],
      thinkingConfig: { includeThoughts: true },
    })
    expect(request.request.tools?.[0]?.functionDeclarations[0]?.name).toBe('external_read_file')
    const retry = await buildAntigravityRequest(options(messages, { sessionId: SessionId('session-fixture') }), credentials)
    expect(request.requestId).toMatch(/^agent-/u)
    expect(retry.requestId).toMatch(/^agent-/u)
    expect(retry.requestId).not.toBe(request.requestId)
    expect(retry.request.sessionId).toBe(request.request.sessionId)
  })

  it('does not enable thinking for the none reasoning effort', async () => {
    const request = await buildAntigravityRequest(options([
      user('u1', [{ type: 'text', text: 'Hello' }]),
    ], { reasoningEffort: ReasoningEffortId('none') }), credentials)
    expect(request.request.generationConfig).toBeUndefined()
  })

  it('rewrites the harness tool schema into the shape Gemini validates', async () => {
    const request = await buildAntigravityRequest(options([
      user('u1', [{ type: 'text', text: 'Run echo hi.' }]),
    ], {
      tools: [{
        name: 'bash',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', required: true, description: 'Command to run' },
            mode: { type: 'string', required: true, const: 'foreground' },
            env: {
              type: 'object',
              properties: { name: { type: 'string', required: true } },
            },
          },
        },
      }],
    }), credentials)
    // A property's boolean `required` becomes the parent's list of names, the
    // only spelling Gemini's Schema takes — it refuses the boolean outright —
    // and a literal it does not know at all becomes the one-value enum that
    // means the same. Both refusals reach the caller as HTTP 400.
    expect(request.request.tools?.[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        mode: { type: 'string', enum: ['foreground'] },
        env: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      required: ['command', 'mode'],
    })
  })

  it('bypasses Gemini signature validation only for the first unsigned parallel tool call', async () => {
    const serialized = await serializeAntigravityMessages([
      assistant('a1', [
        { type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{}' },
        { type: 'tool-call', id: CallId('call-2'), name: 'write_file', arguments: '{}' },
      ]),
    ], 'gemini-test')
    expect(serialized).toEqual([{
      role: 'model',
      parts: [
        {
          functionCall: { name: 'external_read_file', args: {}, id: 'call-1' },
          thoughtSignature: 'skip_thought_signature_validator',
        },
        { functionCall: { name: 'external_write_file', args: {}, id: 'call-2' } },
      ],
    }])
  })

  it('rejects image input without an attachment service', async () => {
    await expect(serializeAntigravityMessages([
      user('u1', [{
        type: 'image',
        attachment: { attachmentId: 'missing' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }],
      )], 'gemini-test')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('resolves durable images into inline Gemini data', async () => {
    const ref = { attachmentId: 'image-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const readImage = vi.fn(async () => ({ ref, data: Uint8Array.of(1, 2, 3) }))
    const attachments = { readImage } as unknown as AttachmentStore
    await expect(serializeAntigravityMessages([
      user('u1', [{ type: 'image', attachment: ref }]),
    ], 'gemini-test', attachments)).resolves.toEqual([{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }],
    }])
    expect(readImage).toHaveBeenCalledWith(ref, undefined)
  })
})

describe('Antigravity model discovery', () => {
  it('normalizes the live catalog and derives image capability', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      models: {
        zeta: { displayName: 'Zeta', maxTokens: 1000, maxOutputTokens: 200, supportsThinking: true },
        alpha: { displayName: 'Alpha', maxTokens: 2000, supportedMimeTypes: { 'image/png': true } },
        internal: { isInternal: true },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(discoverAntigravityModels({ accessToken: credentials.access, projectId: credentials.projectId, fetch })).resolves.toEqual([
      {
        id: 'alpha', name: 'Alpha', contextWindow: 2000, supportsImages: true,
        supportsThinking: false, internal: false,
      },
      {
        id: 'internal', name: 'internal', supportsImages: false,
        supportsThinking: false, internal: true,
      },
      {
        id: 'zeta', name: 'Zeta', contextWindow: 1000, maxTokens: 200,
        supportsImages: false, supportsThinking: true, internal: false,
      },
    ])
    const init = fetch.mock.calls[0]?.[1]
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${credentials.access}` })
    expect(init?.body).toBe(JSON.stringify({ project: credentials.projectId }))
    expect(JSON.stringify(init?.body)).not.toContain(credentials.refresh)
  })

  it('uses the production and sandbox catalog endpoints only after a capability miss', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: { gemini: {} } }), { status: 200 }))
    await expect(discoverAntigravityModels({ accessToken: credentials.access, fetch })).resolves.toMatchObject([
      { id: 'gemini', name: 'gemini' },
    ])
    expect(fetch.mock.calls.map(([input]) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ])
  })

  it('classifies catalog failures without exposing provider response text', async () => {
    const leaked = `credentials=${credentials.access}`
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ error: { message: leaked } }), { status: 400 }))
    let rejection: unknown
    try {
      await discoverAntigravityModels({ accessToken: credentials.access, fetch })
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'INVALID_REQUEST', failure: { status: 400 } })
    expect(String(rejection)).not.toContain(credentials.access)
    expect(String(rejection)).not.toContain(leaked)
  })

  it('does not retain credential-bearing fetch or JSON errors as causes', async () => {
    const leaked = credentials.access
    const fetchFailure = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(`network failure ${leaked}`)
    })
    let fetchRejection: unknown
    try {
      await discoverAntigravityModels({
        accessToken: leaked,
        fetch: fetchFailure,
        endpoint: 'https://fixture.test',
      })
    } catch (error: unknown) {
      fetchRejection = error
    }
    expect(errorChain(fetchRejection)).not.toContain(leaked)

    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockRejectedValue(new Error(`invalid payload ${leaked}`))
    let jsonRejection: unknown
    try {
      await discoverAntigravityModels({
        accessToken: leaked,
        fetch: vi.fn<typeof globalThis.fetch>(async () => response),
        endpoint: 'https://fixture.test',
      })
    } catch (error: unknown) {
      jsonRejection = error
    }
    expect(errorChain(jsonRejection)).not.toContain(leaked)

    const streamFailure = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(`stream failure ${leaked}`)
    })
    let streamRejection: unknown
    try {
      for await (const _chunk of streamAntigravity(
        options([user('u1', [{ type: 'text', text: 'Hello' }])]),
        credentials,
        streamFailure,
        { endpoint: 'https://fixture.test' },
      )) { /* empty */ }
    } catch (error: unknown) {
      streamRejection = error
    }
    expect(errorChain(streamRejection)).not.toContain(leaked)
  })
})

describe('Antigravity SSE transport', () => {
  it('handles fragmented UTF-8 frames and emits reasoning, text, tool, usage, and finish chunks', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(sseBody([
      JSON.stringify({ response: { responseId: 'response-1', candidates: [{ content: { parts: [{ thought: true, text: 'Suy nghĩ 😊', thoughtSignature: 'YWJjZA==' }] } }] } }),
      JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'Kết quả' }] } }] } }),
      JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', id: 'call-1', args: { path: 'README.md' } } }] } }] } }),
      JSON.stringify({ response: { usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, candidatesTokenCount: 5, thoughtsTokenCount: 3 }, candidates: [{ finishReason: 'STOP' }] } }),
    ], 17), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const chunks = []
    for await (const chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Suy nghĩ 😊' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Suy nghĩ 😊' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Kết quả' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Kết quả' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: CallId('call-1'), name: 'read_file', argumentsDelta: '{"path":"README.md"}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{"path":"README.md"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 8, cacheReadTokens: 2, reasoningTokens: 3 } },
      {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: {
          response: { responseId: 'response-1', finishReason: 'STOP' },
          blocks: [{ thoughtSignature: 'YWJjZA==' }, {}, {}],
        },
      },
    ])
    expect(fetch).toHaveBeenCalledWith(
      'https://fixture.test/v1internal:streamGenerateContent?alt=sse',
      expect.objectContaining({ method: 'POST', signal: null }),
    )
  })

  it('continues a tool call after replay metadata is removed', async () => {
    let requestNumber = 0
    const requestContents: unknown[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { request?: { contents?: unknown } }
      requestContents.push(body.request?.contents)
      if (requestNumber++ === 0) {
        return new Response(sseBody([
          JSON.stringify({ response: { responseId: 'response-tool', candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', id: 'call-1', args: { path: 'README.md' } } }] } }] } }),
          JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } }),
        ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(sseBody([
        JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'done' }] } }] } }),
        JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } }),
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const firstChunks: unknown[] = []
    for await (const chunk of streamAntigravity(options([
      user('u1', [{ type: 'text', text: 'Inspect this file.' }]),
    ]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      firstChunks.push(chunk)
    }
    expect(firstChunks).toContainEqual({
      type: 'tool-call-delta',
      index: 0,
      id: CallId('call-1'),
      name: 'read_file',
      argumentsDelta: '{"path":"README.md"}',
    })
    expect(firstChunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: { blocks: [{}] },
    })

    const secondChunks: unknown[] = []
    for await (const chunk of streamAntigravity(options([
      user('u1', [{ type: 'text', text: 'Inspect this file.' }]),
      assistant('a1', [{ type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{"path":"README.md"}' }]),
      user('u2', [{
        type: 'tool-result',
        toolCallId: CallId('call-1'),
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      }]),
    ]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      secondChunks.push(chunk)
    }
    expect(secondChunks).toContainEqual({ type: 'text-delta', index: 0, text: 'done' })
    expect(requestContents).toHaveLength(2)
    expect(requestContents[1]).toEqual([
      { role: 'user', parts: [{ text: 'Inspect this file.' }] },
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'external_read_file',
            args: { path: 'README.md' },
            id: 'call-1',
          },
          thoughtSignature: 'skip_thought_signature_validator',
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'external_read_file',
            response: { output: 'file contents' },
            id: 'call-1',
          },
        }],
      },
    ])
  })

  it('accepts a complete final data line when upstream omits the SSE blank separator and finish reason', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(sseBodyWithoutFinalBlank(JSON.stringify({
      response: {
        responseId: 'response-no-finish',
        candidates: [{ content: { parts: [{ text: 'done' }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      },
    })), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const chunks = []
    for await (const chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      chunks.push(chunk)
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('keeps stream provider errors generic even when the response includes a token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(sseBody([JSON.stringify({
      error: { code: 401, message: `authorization ${credentials.access}` },
    })]), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    let rejection: unknown
    try {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) { /* empty */ }
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'AUTH', failure: { status: 401 } })
    expect(String(rejection)).not.toContain(credentials.access)
  })

  it('falls back on endpoint misses but surfaces quota without leaking token bodies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: `quota exhausted for ${credentials.access}` },
      }), { status: 429 }))
    let rejection: unknown
    try {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch)) {
        // The first request fails before a stream is exposed.
      }
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'QUOTA', failure: { status: 429 } })
    expect(String(rejection)).not.toContain(credentials.access)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('maps cancellation while reading the response to ABORTED', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      controller.abort('cancelled')
      init?.signal?.throwIfAborted()
      return new Response(sseBody([]), { status: 200 })
    })
    await expect(async () => {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])], { signal: controller.signal }), credentials, fetch, { endpoint: 'https://fixture.test' })) { /* empty */ }
    }).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('cancels an open reader after the terminal DONE event', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status: 200 }))
    const chunks = []
    for await (const chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch, { endpoint: 'https://fixture.test' })) {
      chunks.push(chunk)
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
    expect(cancelled).toBe(true)
  })

  it('does not retry another endpoint after visible output starts', async () => {
    const first = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'visible' }] } }] } })}`,
          'data: {broken',
        ].join('\n\n')))
        controller.close()
      },
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(first, { status: 200 }))
      .mockResolvedValueOnce(new Response(sseBody(['[DONE]']), { status: 200 }))
    let rejection: unknown
    try {
      for await (const _chunk of streamAntigravity(options([user('u1', [{ type: 'text', text: 'Hello' }])]), credentials, fetch)) { /* empty */ }
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('Antigravity SSE parser', () => {
  it('joins multiline data fields and rejects an unterminated event', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":\n'))
        controller.enqueue(new TextEncoder().encode('data: 1}\n\n'))
        controller.close()
      },
    })
    const events = []
    for await (const event of parseAntigravitySse(stream)) events.push(event)
    expect(events).toEqual(['{"a":\n1}'])

    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"broken":true}'))
        controller.close()
      },
    })
    await expect(async () => {
      for await (const _event of parseAntigravitySse(broken)) { /* empty */ }
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
