// @vitest-environment jsdom
/** Aggregate activity headers: labels, accessibility, and collapse behavior. */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@hydraharness/harness-client-test-runtime'
import { en as commonEn } from '@hydraharness/harness-client-locale/src/locales/en.ts'
import { ActivityGroup, activityKindForTool, activityKindForTools } from '../src/client/chat/ActivityGroup.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en, commonEn)

describe('ActivityGroup', () => {
  it('folds tool families into the screenshot labels', () => {
    expect(activityKindForTool('bash')).toBe('commands')
    expect(activityKindForTool('read_image')).toBe('image')
    expect(activityKindForTool('image_generate')).toBe('other')
    expect(activityKindForTool('image_generate_google')).toBe('other')
    expect(activityKindForTool('obsidian_knowledge_recall')).toBe('read')
    expect(activityKindForTool('obsidian_knowledge_read')).toBe('read')
    expect(activityKindForTool('obsidian_knowledge_save_approved')).toBe('commands')
    expect(activityKindForTool('browser_click')).toBe('commands')
    expect(activityKindForTool('subagent')).toBe('other')
    expect(activityKindForTools(['read', 'bash'])).toBe('read-commands')
    expect(activityKindForTools(['read', 'grep'])).toBe('read')
  })

  it('starts open, keeps rows mounted, and toggles with an accessible button', () => {
    const view = render(
      <ActivityGroup kind="commands" t={t}>
        <div data-testid="activity-child">Ran Get-Content</div>
      </ActivityGroup>,
    )
    const toggle = screen.getByRole('button', { name: 'Ran commands' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByTestId('activity-child')).toBeTruthy()
    expect(view.getByTestId('activity-child').hasAttribute('hidden')).toBe(false)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByTestId('activity-child')).toBeTruthy()
    expect(view.getByTestId('activity-child').parentElement?.hasAttribute('data-collapsed')).toBe(true)
  })
})
