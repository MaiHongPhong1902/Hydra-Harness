// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ReviewHunk } from '@hydra1902/harness-fs-review/client'
import { DiffView } from '../src/client/DiffView.tsx'

afterEach(cleanup)

function view(hunks: readonly ReviewHunk[], options: Partial<Pick<ComponentProps<typeof DiffView>, 'mode' | 'wordWrap' | 'wordDiffs' | 'hideWhitespace'>> = {}) {
  return render(
    <DiffView
      hunks={hunks}
      path="src/example.ts"
      mode={options.mode ?? 'unified'}
      wordWrap={options.wordWrap ?? false}
      wordDiffs={options.wordDiffs ?? false}
      hideWhitespace={options.hideWhitespace ?? false}
    />,
  )
}

function hunk(lines: string[], header = '@@ -1,3 +1,3 @@'): ReviewHunk {
  return { header, lines }
}

describe('DiffView', () => {
  it.each(['unified', 'split'] as const)('renders unpaired lines, raw context and markers in %s layout', (mode) => {
    const ui = view([hunk(['\\ orphan', 'raw context', '-removed', '\\ old marker', ' context', '+added', '\\ new marker'], 'invalid header')],
      { mode, hideWhitespace: true, wordDiffs: true })
    expect(ui.container.textContent).not.toContain('orphan')
    expect(ui.container.textContent).toContain('raw context')
    expect(ui.container.textContent).toContain('-removed')
    expect(ui.container.textContent).toContain('+added')
    expect(ui.container.querySelectorAll('[data-no-newline]')).toHaveLength(2)
    expect(ui.container.querySelector('[data-old-line]')?.getAttribute('data-old-line')).toBe('1')
    if (mode === 'split') expect(ui.container.querySelectorAll('[data-side][aria-hidden]')).toHaveLength(2)
  })

  it('keeps unequal replacement runs and trims only trailing horizontal whitespace', () => {
    const ui = view([hunk([' context  ', '-same', '-extra', '+same', ' tail', '-prefix', '+prefix and suffix  '])],
      { hideWhitespace: true, wordDiffs: true })
    expect(ui.container.textContent).toContain(' context\n-extra\n tail\n-prefix\n+prefix and suffix')
    expect([...ui.container.querySelectorAll('[data-word-diff]')].map(mark => mark.textContent)).toEqual([' and suffix'])
  })

  it('leaves identical paired lines unmarked and highlights complete Unicode characters', () => {
    const ui = view([hunk(['-same', '+same', ' context', '-🙂 before', '+🙃 before'])], { wordDiffs: true })
    expect([...ui.container.querySelectorAll('[data-word-diff]')].map(mark => mark.textContent)).toEqual(['🙂', '🙃'])
  })

  it('keeps reordered lines visible when hiding whitespace changes', () => {
    const ui = view([hunk(['-first()', '-second()', '+second()', '+first()'])], { hideWhitespace: true })
    expect(ui.getByRole('region').textContent).toContain('-first()\n-second()\n+second()\n+first()')
  })
  it('keeps unified text intact while displaying old and new line numbers', () => {
    const hunks = [hunk([' context', '-A', '+B'])]
    const ui = view(hunks)
    const region = ui.getByRole('region', { name: 'Recorded diff for src/example.ts' })
    expect(region.textContent).toContain(' context\n-A\n+B')
    const lines = [...region.querySelectorAll('[data-diff-line]')]
    expect(lines.map(line => [line.getAttribute('data-old-line'), line.getAttribute('data-new-line')])).toEqual([
      ['1', '1'], ['2', ''], ['', '2'],
    ])
    expect([...region.querySelectorAll('[data-line]')].map(line => line.getAttribute('data-line'))).toEqual(['1', '1', '2', '', '', '2'])
  })

  it('pairs contiguous deletions and additions in split mode and keeps context on both sides', () => {
    const ui = view([hunk([' context', '-old one', '-old two', '+new one', '+new two', ' tail'])], { mode: 'split' })
    const rows = [...ui.container.querySelectorAll('[data-diff-line]')]
    expect(rows).toHaveLength(4)
    expect(rows.map(row => [...row.querySelectorAll('[data-side]')].map(side => side.getAttribute('data-kind')))).toEqual([
      ['context', 'context'], ['del', 'add'], ['del', 'add'], ['context', 'context'],
    ])
    expect(rows[0]?.querySelector('[data-side="old"]')?.getAttribute('data-old-line')).toBe('1')
    expect(rows[0]?.querySelector('[data-side="new"]')?.getAttribute('data-new-line')).toBe('1')
  })

  it('shows no-newline markers without creating numbered diff rows', () => {
    const ui = view([hunk(['-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'], '@@ -4,1 +8,1 @@')])
    const region = ui.getByRole('region')
    expect(region.querySelectorAll('[data-diff-line]')).toHaveLength(2)
    expect(region.querySelectorAll('[data-no-newline]')).toHaveLength(2)
    expect([...region.querySelectorAll('[data-diff-line]')].map(row => [row.getAttribute('data-old-line'), row.getAttribute('data-new-line')])).toEqual([
      ['4', ''], ['', '8'],
    ])
    expect(region.textContent).toContain('-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file')
  })

  it('highlights changed word portions in paired lines', () => {
    const ui = view([hunk(['-return oldValue', '+return newValue'])], { mode: 'split', wordDiffs: true })
    const marks = [...ui.container.querySelectorAll('[data-word-diff]')]
    expect(marks).toHaveLength(2)
    expect(marks.map(mark => mark.textContent)).toEqual(['old', 'new'])
    expect(ui.container.textContent).toContain('-return oldValue')
    expect(ui.container.textContent).toContain('+return newValue')
  })

  it('removes whitespace-only replacements but retains real changes', () => {
    const hunks = [hunk(['-  same', '+same', '-before', '+after'])]
    const ui = view(hunks, { hideWhitespace: true })
    expect(ui.container.textContent).not.toContain('same')
    expect(ui.container.textContent).toContain('-before')
    expect(ui.container.textContent).toContain('+after')
    expect(ui.container.querySelectorAll('[data-diff-line]')).toHaveLength(2)
  })

  it('does not mutate the supplied hunk arrays', () => {
    const hunks = [hunk([' context', '-old', '\\ No newline at end of file', '+new'])]
    const before = hunks.map(item => ({ header: item.header, lines: [...item.lines] }))
    view(hunks, { mode: 'split', hideWhitespace: true, wordDiffs: true, wordWrap: true })
    expect(hunks).toEqual(before)
  })
})
