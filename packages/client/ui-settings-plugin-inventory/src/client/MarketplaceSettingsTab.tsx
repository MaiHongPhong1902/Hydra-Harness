import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  AddPluginMarketplaceRequest,
  PluginMarketplaceSnapshot,
  SetPluginMarketplaceEnablementRequest,
} from '@hydra/harness-api-remotes/client'
import {
  Button,
  IconPlusOutline16,
  Input,
  Modal,
  Switch,
} from '@hydra/harness-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydra/harness-client-ui-slots'
import { marketplaceOwnerLabel, matchesQuery } from './marketplace-owner.ts'
import type { ImportedPluginControls } from './PluginInventorySettingsTab.tsx'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by the marketplace tab. */
export interface MarketplaceSettingsTabInjected {
  /** Only used to stage the just-added source's plugin; the installed list lives in the Plugins tab. */
  importedPlugins: ImportedPluginControls
  /** Read every configured marketplace. */
  listMarketplaces: () => Promise<PluginMarketplaceSnapshot>
  /** Validate and persist one Git-backed or local marketplace root. */
  addMarketplace: (request: AddPluginMarketplaceRequest) => Promise<PluginMarketplaceSnapshot>
  /** Remove one configured marketplace source and uninstall its imported plugins. */
  removeMarketplace: (source: string) => Promise<PluginMarketplaceSnapshot>
  /** Enable or disable one marketplace slot; cascades to its imported plugins. */
  setMarketplaceEnabled: (request: SetPluginMarketplaceEnablementRequest) => Promise<PluginMarketplaceSnapshot>
  /** Prevent marketplace mutations from racing the Plugins tab's staged saves. */
  hasPendingImportedChanges: () => boolean
}

/** Full component props assembled by the Settings slot renderer. */
export type MarketplaceSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<MarketplaceSettingsTabInjected>

type Marketplace = PluginMarketplaceSnapshot['marketplaces'][number]
type SavedMarketplaceRequest = AddPluginMarketplaceRequest & { readonly sparsePaths: readonly string[] }

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginMarketplaceSnapshot }

type MutationFailure = 'add' | 'import' | 'missing-catalog' | 'pending-plugin'

function marketplaceSourceLabel(marketplace: Marketplace): string {
  return marketplace.gitRef === undefined
    ? marketplace.source
    : `${marketplace.source} @ ${marketplace.gitRef}`
}

function isMissingMarketplaceCatalog(error: unknown): boolean {
  return error instanceof Error
    && /\b(?:ENOENT|ENOTDIR)\b/iu.test(error.message)
    && /\bmarketplace\.json\b/iu.test(error.message)
}

function sameMarketplaceRequest(left: SavedMarketplaceRequest, right: SavedMarketplaceRequest): boolean {
  return left.source === right.source
    && left.gitRef === right.gitRef
    && left.sparsePaths.length === right.sparsePaths.length
    && left.sparsePaths.every((path, index) => path === right.sparsePaths[index])
}

/** Add and inspect configured marketplace sources. */
export function MarketplaceSettingsTab({
  active,
  addMarketplace,
  importedPlugins,
  listMarketplaces,
  query,
  removeMarketplace,
  setMarketplaceEnabled,
  hasPendingImportedChanges,
  t,
}: MarketplaceSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [addOpen, setAddOpen] = useState(false)
  const [source, setSource] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [sparsePaths, setSparsePaths] = useState('')
  const [pluginName, setPluginName] = useState('')
  const [adding, setAdding] = useState(false)
  /**
   * The complete source request this dialog already persisted, when a later
   * import failed. Retrying the same request avoids re-adding a record, while
   * editing ref or sparse paths deliberately invalidates that shortcut.
   */
  const [savedRequest, setSavedRequest] = useState<SavedMarketplaceRequest>()
  const [removing, setRemoving] = useState<string>()
  const [toggling, setToggling] = useState<string>()
  const [mutationFailure, setMutationFailure] = useState<MutationFailure>()

  useEffect(() => {
    if (!active) return undefined
    let current = true
    void Promise.resolve().then(() => listMarketplaces()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, listMarketplaces, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const closeAdd = (): void => {
    if (adding) return
    setAddOpen(false)
    setSource('')
    setGitRef('')
    setSparsePaths('')
    setPluginName('')
    setSavedRequest(undefined)
    setMutationFailure(undefined)
  }

  /**
   * Add the source, then import the named plugin when one was named. The two
   * are separate steps because the first one is what a marketplace record is:
   * the source stays saved when the import fails, and `savedRequest` records
   * the complete persisted source options, so retrying the same request imports
   * again rather than re-adding a source the Host already stores. Leaving the
   * plugin name blank adds the source alone.
   */
  const add = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (hasPendingImportedChanges()) {
      setMutationFailure('pending-plugin')
      return
    }
    const normalizedSource = source.trim()
    if (normalizedSource.length === 0) return
    const normalizedGitRef = gitRef.trim()
    const normalizedPluginName = pluginName.trim()
    const request: SavedMarketplaceRequest = {
      source: normalizedSource,
      ...(normalizedGitRef === '' ? {} : { gitRef: normalizedGitRef }),
      sparsePaths: sparsePaths.split(/\r?\n/u).map(path => path.trim()).filter(path => path !== ''),
    }
    setAdding(true)
    setMutationFailure(undefined)
    const saveSource = async (): Promise<void> => {
      if (savedRequest !== undefined && sameMarketplaceRequest(savedRequest, request)) return
      setState({ status: 'ready', snapshot: await addMarketplace(request) })
      setSavedRequest(request)
    }
    void saveSource().then(
      async () => {
        if (normalizedPluginName !== '') {
          try {
            await importedPlugins.import({
              source: normalizedSource,
              ...(normalizedGitRef === '' ? {} : { ref: normalizedGitRef }),
              plugin: normalizedPluginName,
            })
          } catch (_marketplacePluginImportFailed) {
            // The source is stored either way; the notice says so, and the
            // dialog stays open so the plugin name can be corrected.
            setMutationFailure('import')
            return
          }
        }
        closeAdd()
      },
      (error: unknown) => { setMutationFailure(isMissingMarketplaceCatalog(error) ? 'missing-catalog' : 'add') },
    ).finally(() => { setAdding(false) })
  }

  const busy = adding || removing !== undefined || toggling !== undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleMarketplaces = state.status === 'ready'
    ? state.snapshot.marketplaces.filter(marketplace => matchesQuery(
      [marketplace.source, marketplaceOwnerLabel(marketplace.source)],
      normalizedQuery,
    ))
    : []

  const remove = (marketplace: Marketplace): void => {
    if (hasPendingImportedChanges()) {
      setMutationFailure('pending-plugin')
      return
    }
    setRemoving(marketplace.source)
    setMutationFailure(undefined)
    void removeMarketplace(marketplace.source).then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setMutationFailure('add') },
    ).finally(() => { setRemoving(undefined) })
  }

  const toggle = (marketplace: Marketplace): void => {
    if (hasPendingImportedChanges()) {
      setMutationFailure('pending-plugin')
      return
    }
    setToggling(marketplace.source)
    setMutationFailure(undefined)
    void setMarketplaceEnabled({ source: marketplace.source, enabled: !marketplace.enabled }).then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setMutationFailure('add') },
    ).finally(() => { setToggling(undefined) })
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || busy}>
      {state.status === 'loading' ? <p className={css.status}>{t('marketplaceLoading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('marketplaceLoadError')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {!addOpen && mutationFailure === 'pending-plugin'
        ? <p className={css.mutationFailure} role="alert">{t('marketplacePendingPluginChanges')}</p>
        : null}
      {!addOpen && mutationFailure === 'add'
        ? <p className={css.mutationFailure} role="alert">{t('marketplaceMutationError')}</p>
        : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <div className={css.catalogHeading}>
            <h3>{t('marketplaceTab')}</h3>
            <span>{visibleMarketplaces.length}</span>
          </div>
          <div className={css.marketplaceToolbar}>
            <p className={css.marketplaceWarning}>{t('marketplaceTrust')}</p>
            <Button
              variant="toolbar"
              size="sm"
              icon={<IconPlusOutline16 aria-hidden="true" />}
              disabled={busy}
              onClick={() => { setMutationFailure(undefined); setAddOpen(true) }}
            >
              {t('marketplaceAdd')}
            </Button>
          </div>
          {state.snapshot.marketplaces.length === 0
            ? <p className={css.status}>{t('marketplaceEmpty')}</p>
            : null}
          {state.snapshot.marketplaces.length > 0 && visibleMarketplaces.length === 0
            ? <p className={css.status}>{t('emptySearch')}</p>
            : null}
          <div className={css.marketplaces}>
            {visibleMarketplaces.map(marketplace => (
              <section className={css.marketplace} key={marketplace.source}>
                <h4 className={css.marketplaceGroupHeading}>{marketplaceOwnerLabel(marketplace.source)}</h4>
                {marketplace.status === 'ready' ? (
                  <div className={css.marketplaceHeader}>
                    <code title={marketplaceSourceLabel(marketplace)}>{marketplaceSourceLabel(marketplace)}</code>
                    <p className={css.status}>{t('marketplaceSourceReady')}</p>
                  </div>
                ) : (
                  <div className={css.marketplaceHeader}>
                    <code title={marketplaceSourceLabel(marketplace)}>{marketplaceSourceLabel(marketplace)}</code>
                    <p className={css.status}>{t('marketplaceUnavailable')}</p>
                  </div>
                )}
                <label className={css.switchControl}>
                  <span>{toggling === marketplace.source
                    ? t('saving')
                    : t(marketplace.enabled ? 'enabledTag' : 'disabledTag')}</span>
                  <Switch
                    checked={marketplace.enabled}
                    disabled={busy}
                    aria-label={`${t(marketplace.enabled ? 'marketplaceDisable' : 'marketplaceEnable')} ${marketplaceSourceLabel(marketplace)}`}
                    onClick={() => { toggle(marketplace) }}
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title={t('marketplaceRemoveWarning')}
                  onClick={() => { remove(marketplace) }}
                >
                  {t('marketplaceRemove')}
                </Button>
              </section>
            ))}
          </div>
        </div>
      ) : null}

      <Modal
        open={addOpen}
        onClose={closeAdd}
        title={t('marketplaceAddTitle')}
        closeLabel={t('marketplaceClose')}
        description={t('marketplaceAddDescription')}
        footer={(
          <>
            <Button variant="outline" disabled={adding} onClick={closeAdd}>
              {t('marketplaceCancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="marketplace-add-form"
              disabled={adding || source.trim().length === 0}
            >
              {adding ? t('marketplaceAdding') : t('marketplaceSave')}
            </Button>
          </>
        )}
      >
        <form id="marketplace-add-form" className={css.marketplaceForm} onSubmit={add}>
          <label htmlFor="marketplace-source">{t('marketplaceSource')}</label>
          <Input
            id="marketplace-source"
            type="text"
            required
            autoFocus
            value={source}
            placeholder="openai/plugins or git@github.com:org/repo.git"
            disabled={adding}
            onChange={(event) => { setSource(event.currentTarget.value) }}
          />
          <label htmlFor="marketplace-git-ref">{t('marketplaceGitRef')}</label>
          <Input
            id="marketplace-git-ref"
            type="text"
            value={gitRef}
            placeholder="main"
            disabled={adding}
            onChange={(event) => { setGitRef(event.currentTarget.value) }}
          />
          <label htmlFor="marketplace-sparse-paths">{t('marketplaceSparsePaths')}</label>
          <textarea data-hydra-control="field"
            id="marketplace-sparse-paths"
            rows={4}
            value={sparsePaths}
            placeholder="plugins/codex"
            disabled={adding}
            onChange={(event) => { setSparsePaths(event.currentTarget.value) }}
          />
          <label htmlFor="marketplace-plugin-name">{t('marketplacePluginName')}</label>
          <Input
            id="marketplace-plugin-name"
            type="text"
            value={pluginName}
            placeholder="toolkit"
            disabled={adding}
            onChange={(event) => { setPluginName(event.currentTarget.value) }}
          />
          {mutationFailure === 'missing-catalog' ? (
            <p className={css.mutationFailure} role="alert">{t('marketplaceAddError')}</p>
          ) : mutationFailure === 'import' ? (
            <p className={css.mutationFailure} role="alert">{t('marketplaceImportError')}</p>
          ) : mutationFailure === 'add' ? (
            <p className={css.mutationFailure} role="alert">{t('marketplaceMutationError')}</p>
          ) : mutationFailure === 'pending-plugin' ? (
            <p className={css.mutationFailure} role="alert">{t('marketplacePendingPluginChanges')}</p>
          ) : null}
        </form>
      </Modal>
    </div>
  )
}
