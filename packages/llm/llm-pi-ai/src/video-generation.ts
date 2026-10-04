/** Poll accepted video jobs on their original route and download the completed asset. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { MediaGenerationOptions } from '@hydraharness/harness-llm'

const job = z.union([
  z.object({
    name: z.string().regex(/^models\/[a-zA-Z0-9._-]+\/operations\/[a-zA-Z0-9_-]+$/),
    done: z.boolean().optional(), error: z.unknown().optional(),
    response: z.object({ generateVideoResponse: z.object({
      generatedSamples: z.array(z.object({ video: z.object({ uri: z.url() }) })).length(1),
    }) }).optional(),
  }),
  z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), status: z.enum(['queued', 'in_progress', 'completed', 'failed']) }),
  z.object({
    request_id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
    status: z.enum(['pending', 'done', 'expired']).optional(),
    video: z.object({ url: z.url() }).optional(),
  }).refine(value => value.request_id !== undefined || value.status !== undefined),
])

/** Complete one accepted job without resubmitting or changing its credentials.
 * @param response - Accepted generation response, owned by this operation.
 * @param route - Captured provider protocol and base URL.
 * @param read - GET transport; credentials are requested only for the original origin.
 * @param options - Metadata bounds, cancellation, and explicit polling interval.
 * @returns A completed video response whose body is owned by the caller.
 */
export async function completeVideoGeneration(
  response: Response,
  route: { protocol: 'google' | 'openai' | 'xai'; baseURL: string },
  read: (url: URL, authenticated: boolean) => Promise<Response>,
  options: MediaGenerationOptions & { pollIntervalMs: number },
): Promise<Response> {
  if (response.headers.get('content-type')?.startsWith('video/')) return response
  const base = new URL(`${route.baseURL.replace(/\/+$/, '')}/`)
  async function parse(reply: Response) {
    if (!reply.ok) {
      await reply.body?.cancel()
      throw new Error(`Video job request failed (HTTP ${reply.status}); the accepted job was not resubmitted.`)
    }
    if (reply.body === null) throw new Error('Video job response has no body.')
    let bytes = 0
    const body = reply.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > options.maxResponseBytes) throw new Error('Video job response exceeds maxResponseBytes.')
      controller.enqueue(chunk)
    } }))
    return job.parse(await new Response(body).json())
  }
  let value = await parse(response)
  const path = route.protocol === 'google' && 'name' in value ? value.name
    : route.protocol === 'openai' && 'id' in value ? `videos/${value.id}`
      : route.protocol === 'xai' && 'request_id' in value ? `videos/${value.request_id}` : undefined
  if (path === undefined) throw new Error('Video provider returned an invalid job identifier.')
  const statusURL = new URL(path, base)
  let download: URL | undefined
  while (download === undefined) {
    options.signal.throwIfAborted()
    if ('error' in value && value.error !== undefined || 'status' in value && (value.status === 'failed' || value.status === 'expired')) throw new Error('Video generation failed; the accepted job was not resubmitted.')
    if (route.protocol === 'google' && 'name' in value && value.done === true) {
      const uri = value.response?.generateVideoResponse.generatedSamples[0]?.video.uri
      if (uri === undefined) throw new Error('Video provider completed without a video.')
      download = new URL(uri)
    } else if (route.protocol === 'openai' && 'id' in value && value.status === 'completed') download = new URL(`${path}/content`, base)
    else if (route.protocol === 'xai' && 'status' in value && value.status === 'done') {
      if (!('video' in value) || value.video === undefined) throw new Error('Video provider completed without a video.')
      download = new URL(value.video.url)
    } else {
      await delay(options.pollIntervalMs, undefined, { signal: options.signal })
      value = await parse(await read(statusURL, true))
      if (route.protocol === 'google' && (!('name' in value) || value.name !== path)
        || route.protocol === 'openai' && (!('id' in value) || `videos/${value.id}` !== path)
        || route.protocol === 'xai' && (!('status' in value) || value.status === undefined
          || 'request_id' in value && `videos/${value.request_id}` !== path)) {
        throw new Error('Video provider returned status for an unexpected job.')
      }
    }
  }
  // Signed delivery URLs can redirect to provider CDNs. Route credentials never
  // accompany a request to another origin, including provider-owned delivery hosts.
  for (let redirects = 0; redirects <= 5; redirects++) {
    const sameOrigin = download.origin === base.origin
    const deliveryHost = route.protocol === 'google'
      ? download.hostname === 'storage.googleapis.com' || download.hostname.endsWith('.googleusercontent.com')
      : route.protocol === 'xai' && download.hostname.endsWith('.x.ai')
    if (download.username || download.password || download.hash || !sameOrigin && !(download.protocol === 'https:' && deliveryHost)) throw new Error('Video provider returned an unsupported download URL.')
    const content = await read(download, sameOrigin)
    if ([301, 302, 303, 307, 308].includes(content.status)) {
      const location = content.headers.get('location')
      await content.body?.cancel()
      if (location === null) throw new Error('Video download redirect has no location.')
      download = new URL(location, download)
      continue
    }
    if (!content.ok) {
      await content.body?.cancel()
      throw new Error(`Video download failed (HTTP ${content.status}); the accepted job was not resubmitted.`)
    }
    return content
  }
  throw new Error('Video download exceeded the redirect limit.')
}
