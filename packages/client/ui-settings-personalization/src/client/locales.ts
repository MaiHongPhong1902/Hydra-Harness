/** Locale bundle for the Personalization settings section. */

/** Locale keys this section renders. */
export type PersonalizationKey =
  | 'nav'
  | 'instructionsTitle' | 'instructionsDescription' | 'instructionsPlaceholder'
  | 'save' | 'saving' | 'conflict' | 'reload'
  | 'memoryTitle' | 'memoryDescription' | 'memoryEnabled' | 'memoryUse' | 'memorySave'
  | 'memoryHint' | 'memoryListTitle' | 'memoryNone' | 'memoryDelete'
  | 'personalityTitle' | 'personalityDescription'
  | 'personalityFriendly' | 'personalityPragmatic' | 'personalityNone'

/** English copy. */
export const en: Record<PersonalizationKey, string> = {
  nav: 'Personalization',
  instructionsTitle: 'Custom instructions',
  instructionsDescription: 'Give the agent extra instructions and context for all sessions on this host.',
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
  personalityDescription: 'Choose a default tone for the agent\'s responses.',
  personalityFriendly: 'Friendly',
  personalityPragmatic: 'Pragmatic',
  personalityNone: 'None',
}
