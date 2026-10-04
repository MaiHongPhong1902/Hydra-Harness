/** Configured video generation with bounded durable file storage. */
import type { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { toolVideoReferences, toolMediaLabels } from '@hydraharness/harness-attachment'
import type { VideoAttachmentRef } from '@hydraharness/harness-attachment'
import { defineTool } from '@hydraharness/harness-tools'

/** Video routing and storage limits; credentials belong to the selected provider. */
export interface VideoConfig {
  /** Restrict configured-model fallback to this provider route. */
  provider?: string
  /** Model hint after the saved video model selection. */
  model?: string
  /** Deadline covering submission, polling, download, and storage. */
  timeoutMs?: number
  /** Interval between status requests for an accepted video job. */
  pollIntervalMs?: number
  /** Maximum bytes in each provider job response. */
  maxResponseBytes?: number
  /** Maximum downloaded video bytes. */
  maxVideoBytes?: number
  /** Maximum prompt characters. */
  maxPromptChars?: number
}

/** Loader defaults for video polling and storage. */
export const VideoConfig: z<VideoConfig> = z.object({
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number().default(900_000),
  pollIntervalMs: z.number().default(10_000),
  maxResponseBytes: z.number().default(1024 * 1024),
  maxVideoBytes: z.number().default(100 * 1024 * 1024),
  maxPromptChars: z.number().default(32_000),
})

/** Register video_generate using the saved video provider and model.
 * @param ctx - Tool and attachment services, with optional configured LLM routes.
 * @param config - Loader-validated polling and storage limits.
 */
export function registerVideos(ctx: Context, config: VideoConfig): void {
  const resolved = config as Required<VideoConfig>
  for (const field of ['timeoutMs', 'pollIntervalMs', 'maxResponseBytes', 'maxVideoBytes', 'maxPromptChars'] as const) {
    if (!Number.isSafeInteger(resolved[field]) || resolved[field] < 1) throw new TypeError(`tool-media: video.${field} must be a positive safe integer`)
  }
  if (resolved.timeoutMs > 2_147_483_647 || resolved.pollIntervalMs > 2_147_483_647) throw new TypeError('tool-media: video timer limits must not exceed 2147483647')
  if (config.model?.trim() === '' || config.provider?.trim() === '') throw new TypeError('tool-media: video model and provider must not be empty')
  ctx.tools.register(defineTool({
    name: 'video_generate',
    description: 'Generate a video with the configured video model and display it in chat. Uses the connected provider\'s quota or API billing. Do not retry a timeout automatically.',
    timeoutMs: resolved.timeoutMs,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Refine the user request into a video prompt using your current conversation context before calling this tool. Use precise terminology for shot framing, camera movement, subject motion, timing, lighting, and style where the request supports it. Preserve the subject, intent, exact quoted text and its language, counts, duration, aspect ratio, and all constraints or exclusions. Keep the prompt consistent with seconds and size when supplied. Do not invent requirements or add conflicting details. If the user requests an exact prompt or no rewriting, pass that prompt verbatim. Send the final generation prompt only, without commentary.' },
      seconds: { type: 'integer', minimum: 1, maximum: 15, description: 'Duration in seconds; the selected model must support it.' },
      size: { type: 'string', enum: ['1280x720', '720x1280'], description: 'Landscape or portrait video; omitted uses the provider default.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true }, model: { type: 'string', required: true },
          videos: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true },
            bytes: { type: 'integer', required: true, minimum: 1 }, mediaType: { type: 'string', required: true, enum: ['video/mp4', 'video/webm'] },
          } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Generated video with ${value.provider} (${value.model}).` }],
      presentationMeta: (_args, value) => ({ kind: 'tool-videos', ...value }),
    },
    presentCall: args => ({ card: 'media', kind: 'video', title: 'Generate video', prompt: args.prompt,
      ...args.size === undefined ? {} : { aspectRatio: args.size === '1280x720' ? 16 / 9 : 9 / 16 },
    }),
    presentResult: (_args, result) => result.isError ? undefined : ({
      card: 'media', kind: 'video', title: 'Generated video',
      content: toolVideoReferences(result.meta).map(attachment => ({ type: 'video', attachment })), ...toolMediaLabels(result.meta),
    }),
    async execute(args, execution) {
      if (execution.parent !== undefined) throw new Error('video_generate requires Native tool mode for chat presentation.')
      if (args.prompt.trim() === '' || args.prompt.length > resolved.maxPromptChars) throw new TypeError(`Video prompt must contain 1–${resolved.maxPromptChars} characters.`)
      const signal = AbortSignal.any([execution.signal, AbortSignal.timeout(resolved.timeoutMs)])
      const generated = await ctx.get('llm')?.generateMedia({
        endpoint: 'videos', body: { prompt: args.prompt, ...args.seconds === undefined ? {} : { seconds: args.seconds }, ...args.size === undefined ? {} : { size: args.size } },
        ...config.provider === undefined ? {} : { provider: config.provider }, ...config.model === undefined ? {} : { model: config.model },
        signal, maxResponseBytes: resolved.maxResponseBytes, pollIntervalMs: resolved.pollIntervalMs,
      })
      if (generated === undefined) throw new Error('Configure a video model and its credentials on the Models page before generating videos.')
      const response = generated.response
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim()
      if (mediaType !== 'video/mp4' && mediaType !== 'video/webm') {
        await response.body?.cancel()
        throw new Error('Video provider did not return a completed MP4 or WebM video.')
      }
      if (response.body === null) throw new Error('Video provider returned no video bytes.')
      const stream = response.body
      async function* data(): AsyncIterable<Uint8Array> {
        let bytes = 0
        const reader = stream.getReader()
        try {
          while (true) {
            signal.throwIfAborted()
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > resolved.maxVideoBytes) throw new Error('Video response exceeds maxVideoBytes.')
            yield chunk.value
          }
          if (bytes === 0) throw new Error('Video provider returned an empty video.')
        } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
      }
      const video = await ctx.attachments.saveFileStream({ data: data(), name: `generated-video.${mediaType === 'video/mp4' ? 'mp4' : 'webm'}`, signal })
      signal.throwIfAborted()
      const videos: VideoAttachmentRef[] = [{ ...video, mediaType }]
      return { provider: generated.provider, model: generated.model, videos }
    },
  }))
}
