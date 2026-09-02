// @vitest-environment jsdom
/**
 * The Personalization section: custom instructions (editor, save gating,
 * conflict affordance), local-memory controls, and the personality selector.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@bosch/bh-client-test-runtime'
import { createSnapshotStore } from '@bosch/bh-client-runtime/client'
import type { SettingsScopeSnapshot } from '@bosch/bh-client-runtime/client'
import { PersonalizationSection } from '../src/client/PersonalizationSection.tsx'
import type { MemorySettings, PersonalitySettings, PersonalizationSectionProps } from '../src/client/PersonalizationSection.tsx'
import type { InstructionsState } from '../src/client/instructions-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const INSTRUCTIONS_READY: InstructionsState = {
  status: 'ready', draft: 'be nice', savedContent: 'be nice', revision: 'a'.repeat(64), error: null,
}

const PERSONALITY_READY: SettingsScopeSnapshot<PersonalitySettings> = {
  status: 'ready', value: { personality: 'pragmatic' }, base: undefined, user: undefined, revision: 0, writable: true, mode: 'host',
}

const MEMORY_READY: SettingsScopeSnapshot<MemorySettings> = {
  status: 'ready', value: { enabled: true, useMemories: true, generateMemories: true }, base: undefined, user: undefined, revision: 0, writable: true, mode: 'host',
}

function renderSection(
  instructions: Partial<InstructionsState> = {},
  personality: Partial<SettingsScopeSnapshot<PersonalitySettings>> = {},
  memory: Partial<SettingsScopeSnapshot<MemorySettings>> = {},
) {
  const instructionsStore = createSnapshotStore<InstructionsState>({ ...INSTRUCTIONS_READY, ...instructions })
  const personalityStore = createSnapshotStore<SettingsScopeSnapshot<PersonalitySettings>>({ ...PERSONALITY_READY, ...personality })
  const memoryStore = createSnapshotStore<SettingsScopeSnapshot<MemorySettings>>({ ...MEMORY_READY, ...memory })
  const actions = {
    load: vi.fn(() => Promise.resolve()),
    setDraft: vi.fn(),
    save: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    setPersonality: vi.fn(() => Promise.resolve()),
    loadMemories: vi.fn(() => Promise.resolve([])),
    removeMemory: vi.fn(() => Promise.resolve(true)),
    setMemory: vi.fn(() => Promise.resolve()),
  }
  render(<PersonalizationSection {...({
    ...actions,
    close: () => {},
    useInstructions: bindSnapshotSelector(instructionsStore),
    useMemory: bindSnapshotSelector(memoryStore),
    usePersonality: bindSnapshotSelector(personalityStore),
    t: (key: keyof typeof en) => en[key],
  } as unknown as PersonalizationSectionProps)} />)
  return { actions, instructionsStore, personalityStore, memoryStore }
}

describe('PersonalizationSection', () => {
  it('loads once on mount', () => {
    const { actions } = renderSection()
    expect(actions.load).toHaveBeenCalledTimes(1)
  })

  it('shows the loaded draft and disables Save until the draft changes', () => {
    renderSection()

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('be nice')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables Save once the draft diverges and calls save on click', () => {
    const { actions } = renderSection({ draft: 'be nicer' })

    const button = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    expect(actions.save).toHaveBeenCalledTimes(1)
  })

  it('routes typing to setDraft', () => {
    const { actions } = renderSection()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new text' } })

    expect(actions.setDraft).toHaveBeenCalledWith('new text')
  })

  it('shows a busy label and disables Save while saving', () => {
    renderSection({ status: 'saving', draft: 'be nicer' })

    const button = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows the conflict affordance and reloads on click, instead of a plain retry', () => {
    const { actions } = renderSection({ status: 'conflict', draft: 'my edit', error: 'stale' })

    expect(screen.getByRole('alert').textContent).toContain('These instructions changed elsewhere since you loaded them.')
    // Saving stays blocked until the user resolves the conflict.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    expect(actions.reload).toHaveBeenCalledTimes(1)
  })

  it('shows a generic error message outside of a conflict', () => {
    renderSection({ status: 'error', error: 'socket closed' })

    expect(screen.getByRole('alert').textContent).toContain('socket closed')
  })

  it('shows local-memory controls and routes a global change', () => {
    const { actions } = renderSection()

    const enabled = screen.getByRole('checkbox', { name: 'Enable memories' }) as HTMLInputElement
    expect(enabled.checked).toBe(true)
    fireEvent.click(enabled)
    expect(actions.setMemory).toHaveBeenCalledWith('enabled', false)
    expect(screen.getByText('No saved local memories.')).not.toBeNull()
  })

  it('shows the current personality and routes a change to setPersonality', () => {
    const { actions } = renderSection({}, { value: { personality: 'friendly' } })

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('friendly')

    fireEvent.change(select, { target: { value: 'none' } })

    expect(actions.setPersonality).toHaveBeenCalledWith('none')
  })

  it('disables the personality selector while unavailable or read-only', () => {
    renderSection({}, { status: 'unavailable', writable: false })

    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
  })
})
