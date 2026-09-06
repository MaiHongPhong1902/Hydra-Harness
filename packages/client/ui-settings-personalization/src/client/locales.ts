/** Locale bundle for the Personalization settings section. */

/** Locale keys this section renders. */
export type PersonalizationKey =
  | 'nav'
  | 'promptsTitle' | 'unsaved' | 'saveFailed'
  | 'instructionsTitle' | 'instructionsDescription' | 'instructionsPlaceholder'
  | 'save' | 'saving' | 'conflict' | 'reload'
  | 'memoryTitle' | 'memoryDescription' | 'memoryEnabled' | 'memoryUse' | 'memorySave'
  | 'memoryHint' | 'memoryListTitle' | 'memoryNone' | 'memoryDelete'
  | 'personalityTitle' | 'personalityDescription'
  | 'personalityFriendly' | 'personalityPragmatic' | 'personalityNone'

/** English copy. */
export const en: Record<PersonalizationKey, string> = {
  nav: 'Personalization',
  promptsTitle: 'System prompts',
  unsaved: 'Unsaved changes',
  saveFailed: 'Could not save. Your changes are still here; try again.',
  instructionsTitle: 'Custom instructions',
  instructionsDescription: 'Additional guidance for chats on this host. Save to apply from the next model request, including in existing chats. System and direct user instructions take precedence.',
  instructionsPlaceholder: 'Adhere to the following rules for all responses…',
  save: 'Save',
  saving: 'Saving…',
  conflict: 'These instructions changed elsewhere since you loaded them.',
  reload: 'Reload',
  memoryTitle: 'Memory',
  memoryDescription: 'Reviewed memories are stored only on this host and can be used by future top-level chats.',
  memoryEnabled: 'Enable memories',
  memoryUse: 'Use saved memories in new chats',
  memorySave: 'Let new chats save explicit memories',
  memoryHint: 'Use /memories inside a chat to change that chat or add a memory.',
  memoryListTitle: 'Saved memories',
  memoryNone: 'No saved local memories.',
  memoryDelete: 'Delete',
  personalityTitle: 'Personality',
  personalityDescription: 'Choose the default tone for new chats. Save to apply; existing chats keep their tone.',
  personalityFriendly: 'Friendly',
  personalityPragmatic: 'Pragmatic',
  personalityNone: 'None',
}
