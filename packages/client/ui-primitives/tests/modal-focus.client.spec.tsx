// @vitest-environment jsdom
/** Modal focus ownership across nested dialogs, menus, and rerenders. */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Modal } from '../src/Modal.tsx'
import { Menu } from '../src/Menu.tsx'

beforeEach(() => {
  // JSDOM has no layout; tabbable's real visibility logic needs a rendered rectangle.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Dialogs() {
  const [parent, setParent] = useState(false)
  const [child, setChild] = useState(false)
  const [menu, setMenu] = useState(false)
  const [text, setText] = useState('')
  return <>
    <button onClick={() => { setParent(true) }}>Settings</button>
    <Modal open={parent} onClose={() => { setParent(false) }} title="Settings">
      <input aria-label="Draft" value={text} onChange={(event) => { setText(event.target.value) }} />
      <button onClick={() => { setChild(true) }}>Open child</button>
      <Menu portal open={menu} anchor={<button onClick={() => { setMenu(true) }}>Language</button>}
        items={[{ id: 'en', label: 'English' }]} onSelect={() => { setMenu(false) }} onClose={() => { setMenu(false) }} />
      <Modal open={child} title="Child" onClose={() => { setChild(false) }}>
        <input aria-label="Child draft" autoFocus />
      </Modal>
    </Modal>
  </>
}

it('dismisses only the child, restores its opener, and keeps the parent active', () => {
  render(<Dialogs />)
  const trigger = screen.getByRole('button', { name: 'Settings' })
  trigger.focus()
  fireEvent.click(trigger)
  const childTrigger = screen.getByRole('button', { name: 'Open child' })
  childTrigger.focus()
  fireEvent.click(childTrigger)
  expect(document.activeElement).toBe(screen.getByLabelText('Child draft'))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Child' })).toBeNull()
  expect(document.activeElement).toBe(childTrigger)
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(document.activeElement).toBe(trigger)
})

it('keeps portalled menu controls in their dialog and consumes only the menu Escape', () => {
  render(<Dialogs />)
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Language' }))
  const entry = screen.getByRole('menuitem', { name: 'English' })
  expect(screen.getByRole('dialog').contains(entry)).toBe(true)
  entry.focus()
  expect(document.activeElement).toBe(entry)
  fireEvent.keyDown(entry, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
})

it('wraps the explicit tab order and rejects background focus without resetting a draft', () => {
  render(<Dialogs />)
  const trigger = screen.getByRole('button', { name: 'Settings' })
  fireEvent.click(trigger)
  const first = screen.getByRole('button', { name: 'Close' })
  first.tabIndex = 1
  const last = screen.getByRole('button', { name: 'Language' })
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  const draft = screen.getByLabelText('Draft')
  draft.focus()
  expect(fireEvent.keyDown(draft, { key: 'Tab' })).toBe(true)
  fireEvent.change(draft, { target: { value: 'kept' } })
  expect(document.activeElement).toBe(draft)
  trigger.focus()
  expect(document.activeElement).toBe(first)
  expect((draft as HTMLInputElement).value).toBe('kept')
})

it('keeps focus on a headless dialog when it has no tabbable controls', () => {
  render(<Modal open headless title="Notice" onClose={vi.fn()}>Waiting</Modal>)
  const dialog = screen.getByRole('dialog')
  expect(document.activeElement).toBe(dialog)
  expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
  expect(document.activeElement).toBe(dialog)
  expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false)
  expect(document.activeElement).toBe(dialog)
})
