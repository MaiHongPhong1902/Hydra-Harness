import { describe, expect, it } from 'vitest'
import { inferModelEndpoints, isGenerationRejection, supportsConversation } from '../src/model-endpoints.ts'
import { imageAspectRatio } from '../src/generation.ts'

describe('model endpoints', () => {
  it.each([
    ['gpt-image-2', ['images/generations', 'images/edits']],
    ['chatgpt-image-latest', ['images/generations', 'images/edits']],
    ['dall-e-2', ['images/generations', 'images/edits']], ['dall-e-3', ['images/generations']],
    ['gemini-3.1-flash-image', ['images/generations']], ['gemini-3-pro-image-preview', ['images/generations']],
    ['google/gemini-3.1-flash-image', ['images/generations']], ['openai/gpt-image-2', ['images/generations', 'images/edits']],
    ['gemini-3.1-pro', undefined],
    ['grok-imagine-image-2.0', ['images/generations']], ['grok-2-image-1212', ['images/generations']],
    ['xai/grok-imagine-video', ['videos']], ['grok-4.3', undefined],
    ['sora-2-pro', ['videos']], ['text-embedding-3-large', ['embeddings']],
    ['tts-1', ['audio/speech']], ['whisper-1', ['audio/transcriptions', 'audio/translations']],
    ['omni-moderation-latest', ['moderations']], ['gpt-6.1-sol', undefined],
  ])('identifies dedicated endpoints for %s without treating image input as generation', (id, endpoints) => {
    expect(inferModelEndpoints(id)).toEqual(endpoints)
  })
  it('leaves unknown conversation capability advisory and excludes explicit generation-only models', () => {
    expect(supportsConversation(undefined)).toBe(true)
    expect(supportsConversation(['responses', 'images/generations'])).toBe(true)
    expect(supportsConversation(['images/generations', 'images/edits'])).toBe(false)
    expect(supportsConversation(['videos'])).toBe(false)
    expect(supportsConversation([])).toBe(false)
  })
  it('limits fallback to unambiguous HTTP rejections', () => {
    for (const status of [401, 404, 429]) expect(isGenerationRejection(status)).toBe(true)
    for (const status of [200, 400, 403, 408, 500, 503]) expect(isGenerationRejection(status)).toBe(false)
  })
  it('preserves requested image ratios across native and proxy protocols', () => {
    expect(imageAspectRatio('1024x1536')).toBe('2:3')
    expect(imageAspectRatio('1536x1024')).toBe('3:2')
    expect(imageAspectRatio('1024x1024')).toBe('1:1')
    expect(imageAspectRatio('auto')).toBeUndefined()
    expect(imageAspectRatio(undefined)).toBeUndefined()
    for (const value of ['0x1024', '1024x0', 'x', null, 1024, '999999999999999999999x1024']) expect(() => imageAspectRatio(value)).toThrow('Image size')
  })
})
