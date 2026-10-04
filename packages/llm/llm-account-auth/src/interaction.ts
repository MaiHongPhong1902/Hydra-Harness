/** Account OAuth interaction translation shared by native SDK providers. */
import type { AuthEvent, AuthPrompt, AuthInteraction } from '@earendil-works/pi-ai'
import type { AuthorizationSession, AuthorizationPrompt } from '@hydraharness/harness-authorization'
function relay(event: AuthEvent, session: AuthorizationSession): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      session.notify({ message: event.message, ...(link === undefined ? {} : { url: link.url }) })
      return
    }
    case 'auth_url':
      session.notify({
        message: event.instructions ?? 'Open this page to continue signing in.',
        url: event.url,
      })
      return
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      })
      return
    case 'progress':
      session.notify({ message: event.message })
      return
    default:
      session.notify({ message: 'Signing in…' })
  }
}

function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret':
    case 'manual_code':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      }
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      }
  }
}
/** Translate SDK login notices and prompts into the authorization service.
 * @param session - authorization interaction and cancellation.
 * @returns the SDK interaction for this login attempt.
 */
export function accountInteraction(session: AuthorizationSession): AuthInteraction {
  return { signal: session.signal, notify: (event) => { relay(event, session) }, prompt: prompt => session.prompt(restate(prompt)) }
}
