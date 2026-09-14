import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@hydra/harness-attachment'
import { CallId, contentHasFile, createUserMessage, fileHandleText, OFFLOADED_IMAGE_TEXT, offloadRequestImages, projectFilesToText } from '../src/index.ts'
import type { ContentBlock } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

function image(bytes: number): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    },
  }
}

describe('offloadRequestImages', () => {
  it('preserves the original request when its base64 payload fits exactly', () => {
    const messages = [createUserMessage({ content: [image(3), image(3)], source })]
    expect(offloadRequestImages(messages, 8)).toBe(messages)
  })

  it('keeps five 3 MiB images at 20 MiB and offloads the oldest after one more raw byte', () => {
    const rawImageBytes = 3 * 1024 * 1024
    const maxRequestImageBytes = 20 * 1024 * 1024
    const exact = [createUserMessage({
      content: Array.from({ length: 5 }, () => image(rawImageBytes)),
      source,
    })]
    expect(offloadRequestImages(exact, maxRequestImageBytes)).toBe(exact)

    const over = [createUserMessage({
      content: [image(rawImageBytes + 1), ...Array.from({ length: 4 }, () => image(rawImageBytes))],
      source,
    })]
    expect(offloadRequestImages(over, maxRequestImageBytes)[0]?.content).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_TEXT },
      ...Array.from({ length: 4 }, () => image(rawImageBytes)),
    ])
  })

  it('replaces the oldest nested occurrences without mutating durable messages', () => {
    const shared = image(3)
    const messages = [
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('shot'),
          content: [shared],
        }],
        source,
      }),
      createUserMessage({ content: [shared, image(3)], source }),
    ]

    const fitted = offloadRequestImages(messages, 8)
    expect(fitted).not.toBe(messages)
    expect(fitted[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('shot'),
      content: [{ type: 'text', text: OFFLOADED_IMAGE_TEXT }],
    }])
    expect(fitted[1]?.content).toEqual([shared, image(3)])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-result', content: [shared] })
  })

  it('replaces a single image that cannot fit', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    expect(offloadRequestImages(messages, 8)[0]?.content)
      .toEqual([{ type: 'text', text: OFFLOADED_IMAGE_TEXT }])
  })

  it('keeps unchanged nested content while replacing a later image', () => {
    const nested = {
      type: 'tool-result' as const,
      toolCallId: CallId('text-only'),
      content: [{ type: 'text' as const, text: 'kept' }],
    }
    const messages = [createUserMessage({ content: [nested, image(3)], source })]
    expect(offloadRequestImages(messages, 1)[0]?.content).toEqual([
      nested,
      { type: 'text', text: OFFLOADED_IMAGE_TEXT },
    ])
  })
})

describe('file projection', () => {
  function fileBlock(name: string): Extract<ContentBlock, { type: 'file' }> {
    return {
      type: 'file',
      attachment: {
        attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
        name,
        bytes: 42,
      },
    }
  }

  it('detects file blocks at the top level and inside nested tool results', () => {
    expect(contentHasFile([{ type: 'text', text: 'x' }])).toBe(false)
    expect(contentHasFile([fileBlock('a.txt')])).toBe(true)
    expect(contentHasFile([{
      type: 'tool-result',
      toolCallId: CallId('call-1'),
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-2'),
        content: [fileBlock('deep.txt')],
      }],
    }])).toBe(true)
  })

  it('renders the handle with the read path or the explicit no-path fallback', () => {
    const withPath = fileHandleText(fileBlock('notes.pdf').attachment, '/home/.hydra/attachments/v1/files/ab/x/notes.pdf')
    expect(withPath).toContain('"notes.pdf"')
    expect(withPath).toContain('42 bytes')
    expect(withPath).toContain('sha256:abababab')
    expect(withPath).toContain('"/home/.hydra/attachments/v1/files/ab/x/notes.pdf"')
    expect(withPath).toContain('include this saved path in the delegation prompt')
    expect(withPath).toContain('only subagents sharing this execution environment can read it')
    const withoutPath = fileHandleText(fileBlock('notes.pdf').attachment, undefined)
    expect(withoutPath).toContain('current execution environment cannot access a readable path')
    expect(withoutPath).toContain('do not claim to have read it')
  })

  it('replaces every file occurrence with handle text and keeps file-free history identical', () => {
    const plain = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source })]
    expect(projectFilesToText(plain, () => '/p')).toBe(plain)
    const unchangedTool = {
      type: 'tool-result' as const,
      toolCallId: CallId('call-plain'),
      content: [{ type: 'text' as const, text: 'unchanged result' }],
    }
    const messages = [plain[0]!, createUserMessage({
      content: [
        fileBlock('top.csv'),
        { type: 'text', text: 'keep' },
        unchangedTool,
        {
          type: 'tool-result',
          toolCallId: CallId('call-3'),
          content: [fileBlock('nested.csv')],
        },
      ],
      source,
    })]
    const projected = projectFilesToText(messages, ref => `/copies/${ref.name}`)
    expect(projected).not.toBe(messages)
    expect(projected[0]).toBe(messages[0])
    const content = projected[1]!.content
    expect(content[0]).toEqual({ type: 'text', text: fileHandleText(fileBlock('top.csv').attachment, '/copies/top.csv') })
    expect(content[1]).toEqual({ type: 'text', text: 'keep' })
    expect(content[2]).toBe(messages[1]!.content[2])
    const nested = content[3] as Extract<ContentBlock, { type: 'tool-result' }>
    expect(nested.content[0]).toEqual({
      type: 'text',
      text: fileHandleText(fileBlock('nested.csv').attachment, '/copies/nested.csv'),
    })
    // The durable message is untouched: projection returns shallow copies.
    expect(messages[1]!.content[0]!.type).toBe('file')
  })
})
