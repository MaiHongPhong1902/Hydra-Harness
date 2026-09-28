/** `reference` namespace dictionaries for the unified `@` source. */

import type {} from '@hydraharness/harness-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'reference'

/** English dictionary (the key-set source of truth). */
export const en = {
  'section.files': 'Files & folders',
  'section.sessions': 'Session conversations',
  'candidate.file': 'File',
  'candidate.folder': 'Folder',
  'candidate.session': 'Session',
  'candidate.noCwd': '(no cwd)',
} satisfies Record<string, string>

/** The reference namespace key union. */
export type ReferenceKey = keyof typeof en

declare module '@hydraharness/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The unified `@` reference menu's copy. */
    reference: ReferenceKey
  }
}
