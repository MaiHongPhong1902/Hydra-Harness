/** Control classification rejects missing roles and inappropriate exemptions. */
import { describe, expect, it } from 'vitest'
import { findUiControlViolations } from './verify-ui-controls.ts'

describe('native UI control policy', () => {
  it('accepts standard controls, owned editor interiors, and non-field inputs', () => {
    expect(findUiControlViolations(`const view = <>
      <input data-hydra-control="field" type={secret ? 'password' : 'text'} />
      <select data-hydra-control={'compact'}><option>One</option></select>
      <textarea data-hydra-control="field" />
      <input data-hydra-control="embedded" />
      <textarea data-hydra-control="editor" />
      <button aria-haspopup="menu" data-hydra-control="action" />
      <button aria-haspopup="listbox" data-hydra-control="compact" />
      <button aria-haspopup="dialog" />
      <input type="checkbox" /><input type="file" /><input type="hidden" />
    </>`, 'controls.tsx')).toEqual([])
  })

  it.each([
    '<input />', '<select />', '<textarea />', '<input type={kind} />',
    '<button aria-haspopup="menu" />', '<button aria-haspopup="listbox" />', '<button aria-haspopup="tree" />',
    '<input data-hydra-control="editor" />', '<select data-hydra-control="embedded" />',
    '<textarea data-hydra-control="action" />', '<input data-hydra-control={variant} />',
    '<input data-hydra-control="custom" />',
  ])('rejects %s', (source) => {
    expect(findUiControlViolations(`const view = ${source}`, 'controls.tsx')).toEqual([
      expect.stringMatching(/^controls\.tsx:1: .*requires data-hydra-control/),
    ])
  })
})
