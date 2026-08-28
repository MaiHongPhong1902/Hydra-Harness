// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type {
  BrowserAnnotationAttachment, ComposerAttachment, ComposerAttachmentsOwnerProps, ComposerAttachmentsProps,
} from '@bosch/bh-client-ui-conversation/client'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = ((key: string, params?: Readonly<Record<string, unknown>>): string => {
  const messages: Record<string, string> = {
    'image.pending': 'Pending images',
    'image.original': 'Original image',
    'image.preview': 'Original image preview',
    'image.closePreview': 'Close original image preview',
    'browserAnnotation.pending': 'Pending browser annotations',
    'browserAnnotation.comment': 'Add a comment…',
    'image.openOriginal': 'View original',
    'image.scrollLeft': 'Scroll images left',
    'image.scrollRight': 'Scroll images right',
    'image.dropBlocked': 'Images cannot be added right now',
    'image.dropTitle': 'Drag images here to add them',
  }
  if (key === 'image.remove') {
    const name = params?.name
    return `Remove image ${typeof name === 'string' ? name : ''}`
  }
  if (key === 'image.dropDesc') {
    const count = params?.count
    const size = params?.size
    return `Up to ${typeof count === 'number' ? String(count) : ''} images, ${typeof size === 'string' ? size : ''} each`
  }
  if (key === 'browserAnnotation.remove') {
    const name = params?.name
    return `Remove browser annotation ${typeof name === 'string' ? name : ''}`
  }
  return messages[key] ?? key
}) as ComposerAttachmentsProps['t']

function attachment(id: string, name = `${id}.png`): ComposerAttachment {
  return {
    kind: 'image',
    id: id as ComposerAttachment['id'],
    file: new File([Uint8Array.of(1)], name, { type: 'image/png' }),
    previewUrl: `blob:${id}`,
  }
}

function props(overrides: Partial<ComposerAttachmentsOwnerProps> = {}): ComposerAttachmentsProps {
  return {
    attachments: [],
    canAcceptDrop: true,
    onAddImages: () => {},
    onRemoveImage: () => {},
    t,
    ...overrides,
  } as unknown as ComposerAttachmentsProps
}

function annotation(id: string, name = 'browser-annotation.html.txt', comment = ''): BrowserAnnotationAttachment {
  return {
    kind: 'browser-annotation',
    id: id as BrowserAnnotationAttachment['id'],
    file: new File(['<button>Continue</button>'], name, { type: 'text/plain' }),
    comment,
  }
}

describe('ComposerAttachments', () => {
  it('accepts file drops anywhere on the document and keeps non-file drags native', () => {
    const onAddImages = vi.fn()
    const view = render(<ComposerAttachments {...props({
      onAddImages,
      dropLimits: { count: 20, size: '5MB' },
    })} />)

    expect(fireEvent.dragEnter(document.body, { dataTransfer: null })).toBe(true)
    const textTransfer = { types: ['text/plain'], files: [], dropEffect: 'none' }
    expect(fireEvent.dragEnter(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(fireEvent.dragOver(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(fireEvent.drop(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(view.queryByRole('status')).toBeNull()

    const image = attachment('dropped').file
    const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'none' }
    expect(fireEvent.dragEnter(document.body, { dataTransfer })).toBe(false)
    expect(view.getByRole('status').textContent).toContain('Drag images here to add them')
    expect(view.getByRole('status').textContent).toContain('Up to 20 images, 5MB each')
    expect(fireEvent.dragOver(document.body, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(fireEvent.drop(document.body, { dataTransfer })).toBe(false)
    expect(onAddImages).toHaveBeenCalledWith([image])
    expect(view.queryByRole('status')).toBeNull()
  })

  it('tracks nested file drags and clears an aborted drag', () => {
    const view = render(<ComposerAttachments {...props()} />)
    const dataTransfer = { types: ['Files'], files: [], dropEffect: 'none' }
    fireEvent.dragLeave(document.body, {
      dataTransfer: { types: ['text/plain'], files: [], dropEffect: 'none' },
    })
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragLeave(document.body, { dataTransfer, clientX: 5, clientY: 5 })
    expect(view.getByRole('status')).toBeTruthy()
    fireEvent.dragLeave(document.body, { dataTransfer, clientX: 5, clientY: 5 })
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.dragEnter(document.documentElement, { dataTransfer })
    const leftViewport = new Event('dragleave', { bubbles: true, cancelable: true })
    Object.defineProperties(leftViewport, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: -1 },
      clientY: { value: 5 },
    })
    fireEvent(document.documentElement, leftViewport)
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragEnd(window, { dataTransfer })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('shows a blocked drop without forwarding its files', () => {
    const onAddImages = vi.fn()
    const view = render(<ComposerAttachments {...props({ canAcceptDrop: false, onAddImages })} />)
    const image = attachment('blocked').file
    const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'copy' }
    fireEvent.dragEnter(document.body, { dataTransfer })
    expect(view.getByRole('status').textContent).toBe('Images cannot be added right now')
    fireEvent.dragOver(document.body, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('none')
    fireEvent.drop(document.body, { dataTransfer })
    expect(onAddImages).not.toHaveBeenCalled()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('routes rail removal and closes previews on Escape or attachment removal', () => {
    const onRemoveImage = vi.fn()
    const image = attachment('draft-1', 'pixel.png')
    const initial = props({ attachments: [image], onRemoveImage })
    const view = render(<ComposerAttachments {...initial} />)

    fireEvent.click(view.getByRole('button', { name: 'Remove image pixel.png' }))
    expect(onRemoveImage).toHaveBeenCalledWith(image.id)
    fireEvent.click(view.getByTitle('View original'))
    expect(view.getByRole('dialog', { name: 'Original image preview' })).toBeTruthy()
    view.rerender(<ComposerAttachments {...props({ attachments: [], onRemoveImage })} />)
    expect(view.queryByRole('dialog', { name: 'Original image preview' })).toBeNull()

    view.rerender(<ComposerAttachments {...initial} />)
    fireEvent.click(view.getByTitle('View original'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('dialog', { name: 'Original image preview' })).toBeNull()
  })

  it('labels an unnamed attachment and its original-image preview', () => {
    const image = attachment('unnamed', '')
    const view = render(<ComposerAttachments {...props({ attachments: [image] })} />)
    expect(view.getByAltText('Pending images')).toBeTruthy()
    fireEvent.click(view.getByTitle('View original'))
    expect(view.getByAltText('Original image')).toBeTruthy()
  })

  it('renders browser annotations as text-file cards with per-file comments', () => {
    const item = annotation('annotation-1')
    const onComment = vi.fn()
    const onRemove = vi.fn()
    const view = render(<ComposerAttachments {...props({
      browserAnnotations: [item],
      onUpdateBrowserAnnotationComment: onComment,
      onRemoveBrowserAnnotation: onRemove,
    })} />)

    expect(view.getByRole('group', { name: 'Pending browser annotations' })).toBeTruthy()
    const comment = view.getByRole('textbox', { name: 'Add a comment…: browser-annotation.html.txt' })
    expect(comment.getAttribute('placeholder')).toBe('Add a comment…')
    fireEvent.change(comment, { target: { value: 'click this button' } })
    expect(onComment).toHaveBeenCalledWith(item.id, 'click this button')
    fireEvent.click(view.getByRole('button', { name: 'Remove browser annotation browser-annotation.html.txt' }))
    expect(onRemove).toHaveBeenCalledWith(item.id)
  })
})
