import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  AddPluginMarketplaceRequest,
  MarketplacePluginId,
  MarketplacePluginInstallResult,
  PluginMarketplaceSnapshot,
} from '@bosch/bh-api-remotes/client'
import {
  Button,
  IconPlusOutline16,
  Input,
  Modal,
  RiskConfirmation,
} from '@bosch/bh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by the marketplace tab. */
export interface MarketplaceSettingsTabInjected {
  /** Read every configured marketplace. */
  listMarketplaces: () => Promise<PluginMarketplaceSnapshot>
  /** Validate and persist one Git-backed or local marketplace root. */
  addMarketplace: (request: AddPluginMarketplaceRequest) => Promise<PluginMarketplaceSnapshot>
  /** Install one Host-resolved exact package into the active profile. */
  installMarketplacePlugin: (
    source: string,
    pluginId: MarketplacePluginId,
  ) => Promise<MarketplacePluginInstallResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type MarketplaceSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<MarketplaceSettingsTabInjected>

type Marketplace = PluginMarketplaceSnapshot['marketplaces'][number]
type ReadyMarketplace = Extract<Marketplace, { status: 'ready' }>
type MarketplacePlugin = ReadyMarketplace['plugins'][number]

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginMarketplaceSnapshot }

interface PendingInstall {
  readonly source: string
  readonly sourceLabel: string
  readonly plugin: MarketplacePlugin
}

function marketplaceSourceLabel(marketplace: Marketplace): string {
  return marketplace.gitRef === undefined
    ? marketplace.source
    : `${marketplace.source} @ ${marketplace.gitRef}`
}

/** Add marketplace catalogs and install their validated profile bundles. */
export function MarketplaceSettingsTab({
  addMarketplace,
  installMarketplacePlugin,
  listMarketplaces,
  t,
}: MarketplaceSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [addOpen, setAddOpen] = useState(false)
  const [source, setSource] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [sparsePaths, setSparsePaths] = useState('')
  const [adding, setAdding] = useState(false)
  const [pendingInstall, setPendingInstall] = useState<PendingInstall>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [installing, setInstalling] = useState<string>()
  const [mutationFailed, setMutationFailed] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => listMarketplaces()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [listMarketplaces, request])

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
    setMutationFailed(false)
  }

  const add = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalizedSource = source.trim()
    if (normalizedSource.length === 0) return
    const request: AddPluginMarketplaceRequest = {
      source: normalizedSource,
      ...(gitRef.trim() === '' ? {} : { gitRef: gitRef.trim() }),
      sparsePaths: sparsePaths.split(/\r?\n/u).map(path => path.trim()).filter(path => path !== ''),
    }
    setAdding(true)
    setMutationFailed(false)
    void addMarketplace(request).then(
      (snapshot) => {
        setState({ status: 'ready', snapshot })
        setSource('')
        setGitRef('')
        setSparsePaths('')
        setAddOpen(false)
      },
      () => { setMutationFailed(true) },
    ).finally(() => { setAdding(false) })
  }

  const requestInstall = (marketplace: Marketplace, plugin: MarketplacePlugin): void => {
    setMutationFailed(false)
    setAcknowledged(false)
    setPendingInstall({
      source: marketplace.source,
      sourceLabel: marketplaceSourceLabel(marketplace),
      plugin,
    })
  }

  const closeInstall = (): void => {
    if (installing !== undefined) return
    setPendingInstall(undefined)
    setAcknowledged(false)
  }

  const install = (): void => {
    if (pendingInstall === undefined) return
    const { source: marketplaceSource, plugin } = pendingInstall
    const key = `${marketplaceSource}\0${plugin.id}`
    setInstalling(key)
    setMutationFailed(false)
    void installMarketplacePlugin(marketplaceSource, plugin.id).then(
      (result) => {
        setState({ status: 'ready', snapshot: result.snapshot })
        setRestartRequired(current => current || result.restartRequired)
        setPendingInstall(undefined)
        setAcknowledged(false)
      },
      () => {
        setPendingInstall(undefined)
        setAcknowledged(false)
        setMutationFailed(true)
      },
    ).finally(() => { setInstalling(undefined) })
  }

  const busy = adding || installing !== undefined
  const pendingSpec = pendingInstall === undefined
    ? ''
    : `${pendingInstall.plugin.packageName}@${pendingInstall.plugin.version}`

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || busy}>
      {state.status === 'loading' ? <p className={css.status}>{t('marketplaceLoading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('marketplaceLoadError')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <div className={css.marketplaceToolbar}>
            <p className={css.marketplaceWarning}>{t('marketplaceTrust')}</p>
            <Button
              variant="toolbar"
              size="sm"
              icon={<IconPlusOutline16 aria-hidden="true" />}
              disabled={busy}
              onClick={() => { setMutationFailed(false); setAddOpen(true) }}
            >
              {t('marketplaceAdd')}
            </Button>
          </div>
          {mutationFailed && !addOpen && pendingInstall === undefined ? (
            <p className={css.mutationFailure} role="alert">{t('marketplaceMutationError')}</p>
          ) : null}
          {restartRequired ? (
            <p className={css.marketplaceRestart} role="status">{t('marketplaceRestart')}</p>
          ) : null}
          {state.snapshot.marketplaces.length === 0
            ? <p className={css.status}>{t('marketplaceEmpty')}</p>
            : null}
          <div className={css.marketplaces}>
            {state.snapshot.marketplaces.map(marketplace => (
              <section className={css.marketplace} key={marketplace.source}>
                {marketplace.status === 'ready' ? (
                  <>
                    <div className={css.marketplaceHeader}>
                      <h3>{marketplace.name}</h3>
                      <code title={marketplaceSourceLabel(marketplace)}>{marketplaceSourceLabel(marketplace)}</code>
                    </div>
                    {marketplace.plugins.length === 0
                      ? <p className={css.status}>{t('marketplaceNoPlugins')}</p>
                      : (
                        <ul className={css.cards}>
                          {marketplace.plugins.map((plugin) => {
                            const key = `${marketplace.source}\0${plugin.id}`
                            return (
                              <li className={css.card} key={key} data-marketplace-plugin={plugin.id}>
                                <div className={css.marketplacePlugin}>
                                  <strong>{plugin.name}</strong>
                                  <p>{plugin.description}</p>
                                  <code>{plugin.packageName}@{plugin.version}</code>
                                  {plugin.installed
                                    ? <span className={css.installed}>{t('marketplaceInstalled')}</span>
                                    : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => { requestInstall(marketplace, plugin) }}
                                      >
                                        {installing === key ? t('marketplaceInstalling') : t('marketplaceInstall')}
                                      </Button>
                                    )}
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                  </>
                ) : (
                  <div className={css.marketplaceHeader}>
                    <code title={marketplaceSourceLabel(marketplace)}>{marketplaceSourceLabel(marketplace)}</code>
                    <p className={css.status}>{t('marketplaceUnavailable')}</p>
                  </div>
                )}
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
          <textarea
            id="marketplace-sparse-paths"
            rows={4}
            value={sparsePaths}
            placeholder="plugins/codex"
            disabled={adding}
            onChange={(event) => { setSparsePaths(event.currentTarget.value) }}
          />
          {mutationFailed ? (
            <p className={css.mutationFailure} role="alert">{t('marketplaceMutationError')}</p>
          ) : null}
        </form>
      </Modal>

      <RiskConfirmation
        open={pendingInstall !== undefined}
        title={t('marketplaceConfirmTitle')}
        description={t('marketplaceConfirmDescription', {
          package: pendingSpec,
          source: pendingInstall?.sourceLabel ?? '',
        })}
        acknowledgeLabel={t('marketplaceAcknowledge')}
        cancelLabel={t('marketplaceCancel')}
        confirmLabel={installing === undefined ? t('marketplaceInstall') : t('marketplaceInstalling')}
        acknowledged={acknowledged}
        disabled={installing !== undefined}
        onAcknowledgedChange={setAcknowledged}
        onCancel={closeInstall}
        onConfirm={install}
      />
    </div>
  )
}
