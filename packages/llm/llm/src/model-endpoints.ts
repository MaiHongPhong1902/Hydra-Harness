/** Model endpoint metadata and conservative generation family defaults.
 * @module @hydraharness/harness-llm/model-endpoints
 */

/** Infer generation families without using image-input capabilities.
 * @param id - Provider-owned model id.
 * @returns Known endpoint paths, or undefined when the family is unknown.
 */
export function inferModelEndpoints(id: string): string[] | undefined {
  const family = id.slice(id.lastIndexOf('/') + 1)
  if (/^(gpt-image-|chatgpt-image-|dall-e-2$)/i.test(family)) return ['images/generations', 'images/edits']
  if (/^dall-e-3$/i.test(family)) return ['images/generations']
  if (/^gemini-[a-z0-9.-]*image(?:-|$)/i.test(family)) return ['images/generations']
  if (/^(grok-imagine-image|grok-2-image)(?:[.-]|$)/i.test(family)) return ['images/generations']
  if (/^grok-imagine-video(?:[.-]|$)/i.test(family)) return ['videos']
  if (/^sora(?:-|$)/i.test(family)) return ['videos']
  if (/^(text-embedding-|embedding-)/i.test(family)) return ['embeddings']
  if (/^tts-/i.test(family)) return ['audio/speech']
  if (/^whisper-/i.test(family)) return ['audio/transcriptions', 'audio/translations']
  if (/^(omni|text)-moderation/i.test(family)) return ['moderations']
  return undefined
}

/** Whether endpoint metadata permits a conversation request; unknown stays advisory.
 * @param endpoints - Provider-declared relative endpoint paths.
 * @returns False for an explicitly non-conversation model.
 */
export function supportsConversation(endpoints: readonly string[] | undefined): boolean {
  return endpoints === undefined || endpoints.some(endpoint =>
    ['chat/completions', 'responses', 'messages', 'generateContent'].includes(endpoint))
}

/** Explicit HTTP rejections that permit a different generation model without repeating an accepted job.
 * @param status - HTTP response status.
 * @returns Whether generation may try its next configured candidate.
 */
export function isGenerationRejection(status: number): boolean {
  return status === 401 || status === 404 || status === 429
}
