/** Browser contribution that adds Jev to the Models provider dropdown. */

import type { ClientContext } from '@hydra1902/harness-client-runtime/client'
import type { ConnectionHandle } from '@hydra1902/harness-api-remotes/client'
import type {} from '@hydra1902/harness-client-ui-settings-models/client'
import type {} from '@hydra1902/harness-client-ui-settings/client'
import { JevProviderOption } from './JevProviderOption.tsx'

/** The client contribution only needs the slot registry. */
export const inject = ['slots', 'connection', 'settingsScope']

/** Register and dispose the Jev provider option with the Models page. */
export function apply(ctx: ClientContext): void {
  const api = (ctx.get('connection') as ConnectionHandle).api
  ctx.slots.inject('settings.models.provider-option', () => ctx.slots.register({
    name: 'settings.models.provider-option',
    id: 'jev',
    order: 100,
    label: 'Jev',
    inject: () => ({
      hooks: { settings: ctx.settingsScope.describe() },
      saveKey: async (ref: string, value: string): Promise<boolean> => {
        const response = await api.credentials.set({ ref, value })
        return response.result.ok
      },
    }),
  }, JevProviderOption))
}
