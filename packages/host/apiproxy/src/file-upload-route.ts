/** Raw-byte upload carrier for the generic file attachment service. */

export interface FileUploadRouteService<TResult = unknown> {
  uploadStream(input: {
    sessionId: string
    data: AsyncIterable<Uint8Array>
    signal: AbortSignal
    name?: string
  }): Promise<TResult>
}

/** Handle one authenticated streamed upload. Authentication and session ownership belong to the service. */
export async function handleFileUploadHttp<TResult>(
  service: FileUploadRouteService<TResult>, request: Request,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/octet-stream') return new Response('content type must be application/octet-stream', { status: 415 })
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) return new Response('sessionId is required', { status: 400 })
  try {
    const value = await service.uploadStream({ sessionId, data: bodyChunks(request.body), signal: request.signal, ...(url.searchParams.has('name') ? { name: url.searchParams.get('name') ?? '' } : {}) })
    return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return Response.json({ ok: false, error: { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error), details: {} } }, { headers: { 'cache-control': 'no-store' } })
  }
}

async function* bodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return
  const reader = body.getReader()
  try { while (true) { const chunk = await reader.read(); if (chunk.done) return; yield chunk.value } }
  finally { reader.releaseLock() }
}
