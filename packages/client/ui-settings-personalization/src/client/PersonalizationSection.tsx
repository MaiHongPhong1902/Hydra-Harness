/**
 * Personalization settings section: custom instructions, local memories, and
 * the personality selector.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@bosch/bh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import type { InstructionsState } from './instructions-store.ts'
import type { PersonalizationKey } from './locales.ts'
import css from './PersonalizationSection.module.css'

/** The closed set of personality values (mirrors `@bosch/bh-personalization`'s `Personality`). */
export type Personality = 'friendly' | 'pragmatic' | 'none'

/** The personalization settings-namespace shape. */
export interface PersonalitySettings {
  personality: Personality
}

/** Global defaults for the host-local memory store. */
export interface MemorySettings {
  enabled: boolean
  useMemories: boolean
  generateMemories: boolean
}

interface MemoryEntryView {
  id: string
  text: string
  createdAt: number
  updatedAt: number
}

/** Registration-side business face for the Personalization section. */
export interface PersonalizationSectionInjected {
  hooks: {
    /** Custom-instructions editor snapshot, bound by the renderer as useInstructions. */
    instructions: SnapshotStore<InstructionsState>
    /** Personality settings scope, bound by the renderer as usePersonality. */
    personality: SettingsScope<PersonalitySettings>
    /** Memory settings scope, bound by the renderer as useMemory. */
    memory: SettingsScope<MemorySettings>
  }
  /** Read the custom-instructions document; called once when the section first renders. */
  load: () => Promise<void>
  /** Update the custom-instructions editor draft. */
  setDraft: (text: string) => void
  /** Save the custom-instructions draft. */
  save: () => Promise<void>
  /** Discard the local custom-instructions draft and reload the Host's current content. */
  reload: () => Promise<void>
  /** Change the personality preference. */
  setPersonality: (personality: Personality) => Promise<void>
  /** Read saved local memories for the management list. */
  loadMemories: () => Promise<MemoryEntryView[]>
  /** Delete one saved local memory. */
  removeMemory: (id: string) => Promise<boolean>
  /** Change one global memory default. */
  setMemory: (key: keyof MemorySettings, value: boolean) => Promise<void>
}

/** Full component props. */
export type PersonalizationSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.personalization'>
  & InjectFace<PersonalizationSectionInjected>

const PERSONALITY_OPTIONS: readonly { value: Personality; key: PersonalizationKey }[] = [
  { value: 'friendly', key: 'personalityFriendly' },
  { value: 'pragmatic', key: 'personalityPragmatic' },
  { value: 'none', key: 'personalityNone' },
]

/**
 * Render the Personalization section content column.
 * @param props - composed slot props.
 * @returns the section.
 */
export function PersonalizationSection(props: PersonalizationSectionProps): ReactNode {
  const { useInstructions, useMemory, usePersonality, t, load } = props
  const instructions = useInstructions((snapshot: InstructionsState) => snapshot)
  const memory = useMemory((snapshot: SettingsScopeSnapshot<MemorySettings>) => snapshot)
  const personality = usePersonality((snapshot: SettingsScopeSnapshot<PersonalitySettings>) => snapshot)
  const [entries, setEntries] = useState<MemoryEntryView[]>([])
  const [memoryError, setMemoryError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let active = true
    void props.loadMemories().then((next) => {
      if (active) setEntries(next)
    }).catch((error: unknown) => {
      if (active) setMemoryError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [props.loadMemories])

  const dirty = instructions.draft !== instructions.savedContent
  const saving = instructions.status === 'saving'
  const conflicted = instructions.status === 'conflict'
  const currentMemory = memory.status === 'ready'
    ? memory.value ?? { enabled: false, useMemories: true, generateMemories: true }
    : { enabled: false, useMemories: true, generateMemories: true }
  const currentPersonality = personality.status === 'ready' ? personality.value?.personality ?? 'pragmatic' : 'pragmatic'
  const memoryWritable = memory.status === 'ready' && memory.writable

  async function removeMemory(id: string): Promise<void> {
    try {
      if (await props.removeMemory(id)) setEntries(current => current.filter(entry => entry.id !== id))
    } catch (error: unknown) {
      setMemoryError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>

      <section className={css.group}>
        <div className={css.groupHead}>
          <div>
            <h3 className={css.groupTitle}>{t('instructionsTitle')}</h3>
            <p className={css.groupDesc}>{t('instructionsDescription')}</p>
          </div>
          <button
            type="button"
            className={css.primaryButton}
            disabled={!dirty || saving || conflicted}
            onClick={() => { void props.save() }}
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
        <textarea
          className={css.textarea}
          value={instructions.draft}
          placeholder={t('instructionsPlaceholder')}
          spellCheck={false}
          disabled={instructions.status === 'loading'}
          onChange={(event) => { props.setDraft(event.target.value) }}
        />
        {conflicted
          ? (
            <p className={css.error} role="alert">
              {t('conflict')}
              {' '}
              <button type="button" className={css.linkButton} onClick={() => { void props.reload() }}>
                {t('reload')}
              </button>
            </p>
          )
          : null}
        {instructions.status === 'error' && instructions.error !== null
          ? <p className={css.error} role="alert">{instructions.error}</p>
          : null}
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('memoryTitle')}</h3>
        <p className={css.groupDesc}>{t('memoryDescription')}</p>
        <label className={css.checkbox}>
          <input
            type="checkbox"
            checked={currentMemory.enabled}
            disabled={!memoryWritable}
            onChange={(event) => { void props.setMemory('enabled', event.target.checked) }}
          />
          {t('memoryEnabled')}
        </label>
        <label className={css.checkbox}>
          <input
            type="checkbox"
            checked={currentMemory.useMemories}
            disabled={!memoryWritable || !currentMemory.enabled}
            onChange={(event) => { void props.setMemory('useMemories', event.target.checked) }}
          />
          {t('memoryUse')}
        </label>
        <label className={css.checkbox}>
          <input
            type="checkbox"
            checked={currentMemory.generateMemories}
            disabled={!memoryWritable || !currentMemory.enabled}
            onChange={(event) => { void props.setMemory('generateMemories', event.target.checked) }}
          />
          {t('memorySave')}
        </label>
        <p className={css.memoryHint}>{t('memoryHint')}</p>
        <h4 className={css.memoryListTitle}>{t('memoryListTitle')}</h4>
        {entries.length === 0
          ? <p className={css.unavailable}>{t('memoryNone')}</p>
          : <ul className={css.memoryList}>
            {entries.map(entry => (
              <li key={entry.id} className={css.memoryEntry}>
                <span className={css.memoryText}>{entry.text}</span>
                <button type="button" className={css.deleteButton} onClick={() => { void removeMemory(entry.id) }}>
                  {t('memoryDelete')}
                </button>
              </li>
            ))}
          </ul>}
        {memoryError === null ? null : <p className={css.error} role="alert">{memoryError}</p>}
      </section>

      <section className={css.group}>
        <div className={css.personalityRow}>
          <div>
            <h3 className={css.groupTitle}>{t('personalityTitle')}</h3>
            <p className={css.groupDesc}>{t('personalityDescription')}</p>
          </div>
          <select
            className={css.select}
            value={currentPersonality}
            disabled={personality.status !== 'ready' || !personality.writable}
            onChange={(event) => { void props.setPersonality(event.target.value as Personality) }}
          >
            {PERSONALITY_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{t(option.key)}</option>
            ))}
          </select>
        </div>
      </section>
    </div>
  )
}
