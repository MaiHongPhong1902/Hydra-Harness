// Modal: controlled full-viewport dialog (create-workspace and similar).
// The overlay portals to this document's body so ancestor stacking contexts
// cannot leave sticky page controls above the mask. This is still an in-page
// WebUI dialog; it never creates or targets another browser/native window.

import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { tabbable } from 'tabbable'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

/**
 * Render a centered modal over a blurred page mask. The topmost dialog owns
 * keyboard focus and Escape; dismissal restores the opener when it remains mounted.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading and default accessible name.
 * @param props.labelledBy - headless dialog's title element, replacing aria-label.
 * @param props.closeLabel - accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome) for dialogs whose figma frame owns its own
 * header structure; mask, card, Escape, and aria-label remain.
 * @param props.closeLabel - close-button aria label; the owner passes
 * localized copy (this package is cordis-free, so copy arrives via props).
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, labelledBy, closeLabel = 'Close', description, children, footer, className, contentClassName, headless = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  labelledBy?: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose }, [onClose])
  // Capture the opener before a descendant's autoFocus runs during commit.
  const opener = useMemo(() => open ? document.activeElement : null, [open])
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!open || dialog === null) return
    const doc = dialog.ownerDocument
    const isTopmost = () => Array.from(doc.querySelectorAll('[role="dialog"][aria-modal="true"]')).at(-1) === dialog
    const focusFirst = () => { (tabbable(dialog)[0] ?? dialog).focus() }
    if (isTopmost() && !dialog.contains(doc.activeElement)) focusFirst()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isTopmost()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        closeRef.current()
      } else if (e.key === 'Tab') {
        const candidates = tabbable(dialog)
        const first = candidates[0] ?? dialog
        const last = candidates.at(-1) ?? dialog
        const atEdge = doc.activeElement === (e.shiftKey ? first : last)
        if (atEdge || !candidates.includes(doc.activeElement as HTMLElement)) {
          e.preventDefault()
          const target = e.shiftKey ? last : first
          target.focus()
        }
      }
    }
    const onFocus = (e: FocusEvent) => {
      if (isTopmost() && e.target instanceof Node && !dialog.contains(e.target)) focusFirst()
    }
    doc.addEventListener('keydown', onKeyDown)
    doc.addEventListener('focusin', onFocus)
    return () => {
      doc.removeEventListener('keydown', onKeyDown)
      doc.removeEventListener('focusin', onFocus)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [open, opener])

  if (!open) return null

  return createPortal((
    <div className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        className={clsx(css.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy === undefined ? title : undefined}
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
