/**
 * Personalization settings section, browser half: custom instructions
 * (`settings.readInstructions`/`writeInstructions`), local memory controls,
 * and the personality selector. The two settings namespaces are owned
 * host-side by `@bosch/bh-personalization`.
 */

import type { ConnectionHandle } from '@bosch/bh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@bosch/bh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry) and ctx.settingsScope.
import type {} from '@bosch/bh-client-ui-settings/client'
import type { ClientContext } from '@bosch/bh-client-runtime/client'
import { InstructionsController } from './instructions-store.ts'
import { en } from './locales.ts'
import type { PersonalizationKey } from './locales.ts'
import { PersonalizationSection } from './PersonalizationSection.tsx'
import type { MemorySettings, PersonalitySettings, PersonalizationSectionInjected } from './PersonalizationSection.tsx'

export type { MemorySettings, Personality, PersonalitySettings, PersonalizationSectionInjected, PersonalizationSectionProps } from './PersonalizationSection.tsx'
export type { InstructionsState, InstructionsStatus } from './instructions-store.ts'
export type { PersonalizationKey } from './locales.ts'

declare module '@bosch/bh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.personalization': PersonalizationKey
  }
}

/** Settings namespace registered host-side by `@bosch/bh-personalization`. */
const PERSONALIZATION_NAMESPACE = 'personalization'
const MEMORY_NAMESPACE = 'memory'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

/**
 * Mount the Personalization settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const instructions = new InstructionsController(api)
  const personality = ctx.settingsScope.bind<PersonalitySettings>({ namespace: PERSONALIZATION_NAMESPACE })
  const memory = ctx.settingsScope.bind<MemorySettings>({ namespace: MEMORY_NAMESPACE })

  ctx.effect(() => ctx.locale.register('settings.personalization', { en }), 'ui-settings-personalization: dictionaries')
  ctx.effect(() => () => { instructions.dispose() }, 'ui-settings-personalization: instructions controller')

  const sectionInjected = (): PersonalizationSectionInjected => ({
    hooks: { instructions: instructions.store, personality, memory },
    load: () => instructions.load(),
    setDraft: (text: string) => { instructions.setDraft(text) },
    save: () => instructions.save(),
    reload: () => instructions.load(),
    setPersonality: value => personality.set('personality', value),
    loadMemories: async () => {
      const response = await api.settings.listMemories({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      return response.result.value.entries
    },
    removeMemory: async (id) => {
      const response = await api.settings.removeMemory({ id })
      if (!response.result.ok) throw new Error(response.result.error.message)
      return response.result.value.removed
    },
    setMemory: (key, value) => memory.set(key, value),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'personalization',
    order: 1,
    label: () => ctx.locale.bind('settings.personalization')('nav'),
    locale: 'settings.personalization',
    inject: sectionInjected,
  }, PersonalizationSection))
}
