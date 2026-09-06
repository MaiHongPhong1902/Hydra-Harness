// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PluginMarketplaceSnapshot } from '@hydra/harness-api-remotes/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type {
  MarketplaceSettingsTabInjected,
  MarketplaceSettingsTabProps,
} from '../src/client/MarketplaceSettingsTab.tsx'
import type { ImportedPluginControls } from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const SOURCE = 'https://github.com/example/plugins.git'
const EMPTY: PluginMarketplaceSnapshot = { marketplaces: [] }
const READY: PluginMarketplaceSnapshot = {
  marketplaces: [{
    status: 'ready',
    source: SOURCE,
    gitRef: 'main',
    sparsePaths: ['plugins/codex'],
    enabled: true,
  }],
}
const IMPORTED = {
  plugins: [{
    identity: 'toolkit@local' as never,
    name: 'Toolkit',
    version: '4.9.0',
    source: { kind: 'local' as const, source: 'C:\\plugins\\toolkit', sourceId: 'local' },
    pluginRoot: 'C:\\plugins\\toolkit',
    dataPath: 'C:\\data\\toolkit',
    enabled: false,
    lifecycle: 'installed' as const,
    hookTrustState: 'pending' as const,
    skills: ['toolkit'],
    mcpServers: [],
    hooks: [],
    installationStatus: 'installed' as const,
  }],
} as const
const t = ((key: PluginInventoryLocaleKey, values?: Readonly<Record<string, string>>): string => {
  let text = en[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value)
  return text
}) as MarketplaceSettingsTabProps['t']

function props(
  overrides: Partial<MarketplaceSettingsTabInjected> & { query?: string } = {},
): MarketplaceSettingsTabProps {
  const importedPlugins: ImportedPluginControls = {
    list: vi.fn(async () => IMPORTED),
    import: vi.fn(async () => IMPORTED),
    enable: vi.fn(async () => IMPORTED),
    disable: vi.fn(async () => IMPORTED),
    remove: vi.fn(async () => ({ plugins: [] })),
  }
  return {
    t,
    importedPlugins,
    listMarketplaces: vi.fn(async () => EMPTY),
    addMarketplace: vi.fn(async () => EMPTY),
    removeMarketplace: vi.fn(async () => EMPTY),
    setMarketplaceEnabled: vi.fn(async () => EMPTY),
    query: '',
    active: true,
    ...overrides,
  } as MarketplaceSettingsTabProps
}

describe('MarketplaceSettingsTab', () => {
  it('adds a Git marketplace and imports its selected plugin', async () => {
    const addMarketplace = vi.fn<MarketplaceSettingsTabInjected['addMarketplace']>()
      .mockRejectedValueOnce(new Error('private catalog detail'))
      .mockRejectedValueOnce(new Error("pluginInventory.addMarketplace failed: internal: ENOENT: no such file or directory, lstat 'C:\\private\\marketplace.json'"))
      .mockResolvedValue(READY)
    const importedPlugins = props().importedPlugins
    render(<MarketplaceSettingsTab {...props({ addMarketplace, importedPlugins })} />)

    await screen.findByText(en.marketplaceEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceAdd }))
    const dialog = screen.getByRole('dialog', { name: en.marketplaceAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplaceSource }), {
      target: { value: `  ${SOURCE}  ` },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplaceGitRef }), {
      target: { value: '  main  ' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplaceSparsePaths }), {
      target: { value: ' plugins/codex \n\nplugins/shared ' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplacePluginName }), {
      target: { value: '  example-plugin  ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.marketplaceMutationError)
    expect(screen.queryByText('private catalog detail')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).toBe(en.marketplaceAddError)
    })
    expect(screen.queryByText(/C:\\private\\marketplace\.json/u)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))
    await waitFor(() => { expect(addMarketplace).toHaveBeenCalledTimes(3) })
    expect(addMarketplace).toHaveBeenLastCalledWith({
      source: SOURCE,
      gitRef: 'main',
      sparsePaths: ['plugins/codex', 'plugins/shared'],
    })
    await waitFor(() => {
      expect(importedPlugins.import).toHaveBeenCalledWith({
        source: SOURCE,
        ref: 'main',
        plugin: 'example-plugin',
      })
    })
    expect(await screen.findByText(`${SOURCE} @ main`)).toBeTruthy()
    expect(screen.getByText(en.marketplaceSourceReady)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('keeps the add dialog open when importing the named plugin fails, and does not re-add the saved source', async () => {
    const importedPlugins = props().importedPlugins
    vi.mocked(importedPlugins.import).mockRejectedValue(new Error('ambiguous marketplace'))
    const addMarketplace = vi.fn(async () => READY)
    render(<MarketplaceSettingsTab {...props({ addMarketplace, importedPlugins })} />)

    await screen.findByText(en.marketplaceEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceAdd }))
    const dialog = screen.getByRole('dialog', { name: en.marketplaceAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplaceSource }), {
      target: { value: SOURCE },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplacePluginName }), {
      target: { value: 'example-plugin' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.marketplaceImportError)
    expect(importedPlugins.import).toHaveBeenCalledWith({ source: SOURCE, plugin: 'example-plugin' })
    expect(screen.getByRole('dialog', { name: en.marketplaceAddTitle })).toBeTruthy()
    // The source reached the Host; the row is already listed behind the dialog.
    expect(screen.getByText(`${SOURCE} @ main`)).toBeTruthy()

    // Retrying imports again rather than adding a record the Host already holds.
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))
    await waitFor(() => { expect(importedPlugins.import).toHaveBeenCalledTimes(2) })
    expect(addMarketplace).toHaveBeenCalledTimes(1)
  })

  it('adds the source alone when no plugin is named', async () => {
    const importedPlugins = props().importedPlugins
    render(<MarketplaceSettingsTab {...props({
      addMarketplace: vi.fn(async () => READY),
      importedPlugins,
    })} />)

    await screen.findByText(en.marketplaceEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.marketplaceAdd }))
    const dialog = screen.getByRole('dialog', { name: en.marketplaceAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.marketplaceSource }), {
      target: { value: SOURCE },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: en.marketplaceSave }))

    expect(await screen.findByText(`${SOURCE} @ main`)).toBeTruthy()
    expect(importedPlugins.import).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: en.marketplaceAddTitle })).toBeNull()
  })

  it('does not render the imported-plugin catalog; that list lives in the Plugins tab', async () => {
    const importedPlugins = props().importedPlugins
    render(<MarketplaceSettingsTab {...props({ importedPlugins })} />)

    await screen.findByText(en.marketplaceEmpty)
    expect(importedPlugins.list).not.toHaveBeenCalled()
    expect(screen.queryByText('Toolkit')).toBeNull()
    expect(screen.queryByRole('heading', { name: en.importedPlugins })).toBeNull()
  })

  it('labels each marketplace section with its owner and filters by the shared query', async () => {
    const listMarketplaces = vi.fn(async () => READY)
    const { rerender } = render(<MarketplaceSettingsTab {...props({ listMarketplaces })} />)

    expect(await screen.findByText('example')).toBeTruthy()
    expect(screen.getByText(`${SOURCE} @ main`)).toBeTruthy()

    rerender(<MarketplaceSettingsTab {...props({ listMarketplaces, query: 'no-match' })} />)
    await waitFor(() => { expect(screen.queryByText(`${SOURCE} @ main`)).toBeNull() })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('toggles a marketplace slot through setMarketplaceEnabled', async () => {
    const setMarketplaceEnabled = vi.fn(async () => EMPTY)
    render(<MarketplaceSettingsTab {...props({
      listMarketplaces: vi.fn(async () => READY),
      setMarketplaceEnabled,
    })} />)

    const toggle = await screen.findByRole('switch', { name: `${en.marketplaceDisable} ${SOURCE} @ main` })
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(setMarketplaceEnabled).toHaveBeenCalledWith({ source: SOURCE, enabled: false })
    })
  })
})
