/**
 * The session-log record of which personality preference a session actually
 * runs, and the closed set of personality values.
 *
 * A session's personality is a prompt-affecting fact ("model-visible ⟺
 * logged"), so it is recorded once, in the session's own log, the first time
 * an agent starts under a non-default preference; a resumed or forked session
 * rebuilds the personality its history was produced under, not whatever the
 * global preference has since become. Reconstruction reads
 * {@link resolveSessionPersonality}, never the live settings value alone.
 * @module @hydra1902/harness-personalization/session
 */

import type { SessionEvent } from '@hydra1902/harness-session'

/** The closed set of personality values a session may run under. */
export const PERSONALITIES = ['friendly', 'pragmatic', 'none'] as const

/** One personality value. */
export type Personality = typeof PERSONALITIES[number]

/** The personality a session runs under absent any logged selection. */
export const DEFAULT_PERSONALITY: Personality = 'pragmatic'

/** One bounded local memory entry. */
export interface MemoryEntry {
  id: string
  text: string
  createdAt: number
  updatedAt: number
}

/** Per-chat memory permissions, recorded before the first request. */
export interface MemoryPolicy {
  useMemories: boolean
  generateMemories: boolean
}

/** Default host memory policy. Memory is opt-in globally, recall is on when enabled. */
export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  useMemories: true,
  generateMemories: true,
}

declare module '@hydra1902/harness-session/types' {
  interface SessionEventMap {
    /**
     * The session's personality preference took effect, newest selection
     * winning. Log-only provenance: recorded once, the first time an agent
     * starts this session under a non-default preference, so a resumed or
     * forked session rebuilds the personality its history was produced
     * under instead of the current global preference.
     */
    'personalization/personality': { personality: Personality }
    /** Effective per-chat memory permissions; the last event wins. */
    'memory/policy': MemoryPolicy
    /** Explicit user acceptance of one memory entry. */
    'memory/accepted': { id: string }
  }
}

/** The minimum a caller must supply to resolve a session's personality. */
export interface PersonalityBearingSession {
  /** The session's event log, oldest first. */
  readonly events: readonly SessionEvent[]
}

/**
 * The personality a session actually runs, newest selection winning.
 * @param session - the session's event log.
 * @returns the last logged personality, or {@link DEFAULT_PERSONALITY} when none was ever logged.
 */
export function resolveSessionPersonality(session: PersonalityBearingSession): Personality {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'personalization/personality') return event.data.personality
  }
  return DEFAULT_PERSONALITY
}

/**
 * Whether a session has ever logged a personality selection.
 * @param session - the session's event log.
 * @returns true once at least one `personalization/personality` event exists.
 */
export function hasLoggedPersonality(session: PersonalityBearingSession): boolean {
  return session.events.some(event => event.type === 'personalization/personality')
}

/**
 * Resolve the latest memory policy recorded in a session.
 * @param session - the session whose logged policy is resolved.
 * @returns the latest logged policy, or the default when none was logged.
 */
export function resolveMemoryPolicy(session: PersonalityBearingSession): MemoryPolicy {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'memory/policy') return event.data
  }
  return DEFAULT_MEMORY_POLICY
}

/**
 * Whether a session already owns a durable memory-policy snapshot.
 * @param session - the session whose log is inspected.
 * @returns whether a memory policy was logged.
 */
export function hasLoggedMemoryPolicy(session: PersonalityBearingSession): boolean {
  return session.events.some(event => event.type === 'memory/policy')
}
