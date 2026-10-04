/** Shared column labels and generation-role controls for provider model catalogs. */

import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type Copy = (key: keyof typeof en) => string

/** Render the labels aligned with configured model inputs and role checkboxes.
 * @param props - Section copy.
 * @returns The four visible column labels; each control has its own accessible name.
 */
export function ModelColumnHeaders({ t }: { t: Copy }): ReactNode {
  return <div className={styles['modelColumns']} aria-hidden="true">
    <span>{t('modelId')}</span>
    <span>{t('fetchModelName')}</span>
    <span>{t('modelImage')}</span>
    <span>{t('modelVideo')}</span>
  </div>
}

/** Render one role checkbox, preserving the other role and existing image-edit support.
 * @param props - Endpoint metadata, role, model label, copy, and draft update callback.
 * @returns A native checkbox; clearing the last role explicitly classifies the model as conversation.
 */
export function ModelTypeCheckbox(props: {
  endpoints: readonly string[] | undefined
  role: 'image' | 'video'
  model: string | number
  t: Copy
  disabled?: boolean
  onChange: (endpoints: string[]) => void
}): ReactNode {
  const { endpoints, role, t } = props
  return <label className={`${styles['candidateLabel']} ${styles['modelTypeCell']}`}>
    <span className={styles['modelRoleCaption']} aria-hidden="true">{t(role === 'image' ? 'modelImage' : 'modelVideo')}</span>
    <input type="checkbox" disabled={props.disabled}
      aria-label={`${t(role === 'image' ? 'modelImage' : 'modelVideo')} ${props.model}`}
      checked={endpoints?.includes(role === 'image' ? 'images/generations' : 'videos') === true}
      onChange={(event) => {
        const image = role === 'image' ? event.target.checked : endpoints?.includes('images/generations') === true
        const video = role === 'video' ? event.target.checked : endpoints?.includes('videos') === true
        props.onChange(image || video ? [
          ...image ? ['images/generations', ...endpoints?.includes('images/edits') === true ? ['images/edits'] : []] : [],
          ...video ? ['videos'] : [],
        ] : ['chat/completions'])
      }} />
  </label>
}
