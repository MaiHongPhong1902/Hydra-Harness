// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MarketplacePluginId, PluginMarketplaceSnapshot } from '@bosch/bh-api-remotes/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type {
  MarketplaceSettingsTabInjected,
  MarketplaceSettingsTabProps,
} from '../src/client/MarketplaceSettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const SOURCE = 'https://plugins.example/marketplace.json'
const PLUGIN_ID = 'example-plugin' as MarketplacePluginId
const EMPTY: PluginMarketplaceSnapshot = { marketplaces: [] }
const READY: PluginMarketplaceSnapshot = {
  marketplaces: [{
    status: 'ready',
    source: SOURCE,
    name: 'Example marketplace',
    plugins: [{
      id: PLUGIN_ID,
      name: 'Example plugin',
      description: 'Adds one example capability.',
      packageName: '@example/bh-plugin',
      version: '1.2.3',
      installed: false,
    }],
  }],
}
const INSTALLED: PluginMarketplaceSnapshot = {
  marketplaces: [{
    status: 'ready',
    source: SOURCE,
    name: 'Example marketplace',
    plugins: [{
      id: PLUGIN_ID,
      name: 'Example plugin',
      description: 'Adds one example capability.',
      packageName: '@example/bh-plugin',
      version: '1.2.3',
      installed: true,
    }],
  }],
}

const t = ((key: PluginInventoryLocaleKey, values?: Readonly<Record<string, string>>): string => {
  let text = en[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value)
  return text
}) as MarketplaceSettingsTabProps['t']

function props(overrides: Partial<MarketplaceSettingsTabInjected> = {}): MarketplaceSettingsTabProps {
  return {
    t,
    listMarketplaces: vi.fn(async () => EMPTY),
    addMarketplace: vi.fn(async () => EMPTY),
    installMarketplacePlugin: vi.fn(async () => ({ snapshot: EMPTY, restartRequired: false })),
    ...overrides,
  } as MarketplaceSettingsTabProps
}

describe('MarketplaceSettingsTab', () => {
  it('adds a marketplace URL and renders the validated catalog', async () => {
    const addMarketplace = vi.fn<MarketplaceSettingsTabInjected['addMarketplace']>()
      .mockRejectedValueOnce(new Error('private catalog detail'))
      .mockResolvedValue(READY)
    render(<MarketplaceSettingsTab {...props({ addMarketplace })} />)

    await screen.findByText(en.marketplaceEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceAdd }))
    const dialog = screen.getByRole('dialog', { name: en.marketplaceAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplaceSource }), {
      target: { value: `  ${SOURCE}  ` },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.marketplaceMutationError)
    expect(screen.queryByText('private catalog detail')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))
    await waitFor(() => { expect(addMarketplace).toHaveBeenCalledTimes(2) })
    expect(addMarketplace).toHaveBeenLastCalledWith(SOURCE)
    expect(await screen.findByRole('heading', { name: 'Example marketplace' })).toBeTruthy()
    expect(screen.getByText('@example/bh-plugin@1.2.3')).toBeTruthy()
  })

  it('requires trust acknowledgement, reports a failed install, and shows restart after retry', async () => {
    const installMarketplacePlugin = vi.fn<MarketplaceSettingsTabInjected['installMarketplacePlugin']>()
      .mockRejectedValueOnce(new Error('private host detail'))
      .mockResolvedValueOnce({ snapshot: INSTALLED, restartRequired: true })
    render(<MarketplaceSettingsTab {...props({
      listMarketplaces: vi.fn(async () => READY),
      installMarketplacePlugin,
    })} />)

    await screen.findByText('@example/bh-plugin@1.2.3')
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceInstall }))
    let dialog = screen.getByRole('dialog', { name: en.marketplaceConfirmTitle })
    expect(within(dialog).getByText(`Install @example/bh-plugin@1.2.3 from ${SOURCE}. The plugin will run on the host after restart.`)).toBeTruthy()
    let confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.marketplaceInstall })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en.marketplaceAcknowledge }))
    fireEvent.click(confirm)

    expect((await screen.findByRole('alert')).textContent).toBe(en.marketplaceMutationError)
    expect(screen.queryByText('private host detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceInstall }))
    dialog = screen.getByRole('dialog', { name: en.marketplaceConfirmTitle })
    confirm = within(dialog).getByRole('button', { name: en.marketplaceInstall })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en.marketplaceAcknowledge }))
    fireEvent.click(confirm)

    await waitFor(() => { expect(installMarketplacePlugin).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.marketplaceInstalled)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en.marketplaceRestart)
    expect(installMarketplacePlugin).toHaveBeenLastCalledWith(SOURCE, PLUGIN_ID)
  })
})
