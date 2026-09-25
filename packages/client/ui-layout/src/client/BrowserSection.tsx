/** Desktop-only Browser preferences and native browser-data managers. */
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Modal, RiskConfirmation } from '@hydra/harness-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@hydra/harness-client-ui-slots'
import type { SettingsScopeSnapshot } from '@hydra/harness-client-runtime/client'
import type { BrowserKey } from './browser-locales.ts'
import type {
  BrowserAnnotationScreenshots, BrowserAutofillStatus, BrowserContact, BrowserContactFields,
  BrowserClearDataScope, BrowserContactInput, BrowserContactMetadata, BrowserDestination, BrowserDownloadEntry,
  BrowserHistoryEntry, BrowserLoginInput, BrowserLoginMetadata, BrowserNativeCapabilities,
  BrowserNativeSettings, BrowserPolicy, BrowserSitePermission,
} from './DesktopBrowserPanel.tsx'
import css from './BrowserSection.module.css'

/** Durable values consumed by the Browser settings surface. */
export interface BrowserSettings extends BrowserNativeSettings {
  /** Global permissions; legacy policy fields remain the fallback for saved profiles. */
  browserPermissions?: { browsing: BrowserPolicy; downloads: BrowserPolicy; uploads: BrowserPolicy }
  /** Whether agent browser actions are accepted by the Host. */
  controlEnabled: boolean
  /** Whether the agent may query the built-in browser history. */
  historyAccessPolicy: BrowserPolicy
}

/** Namespace registered by browser-electron. */
export const BROWSER_SETTINGS_NAMESPACE = 'browser-electron'

/** Narrow face injected into the Browser section. */
export interface BrowserSectionInjected {
  /** Persist one typed Browser setting. */
  setSetting<K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]): Promise<void>
  /** Apply one authoritative Host snapshot to the native controller. */
  configureNative(settings: BrowserNativeSettings): Promise<BrowserNativeCapabilities>
  /** Ask the local Host for a download directory. */
  pickDownloadDirectory(): Promise<string | null>
  clearData(scope: BrowserClearDataScope): Promise<void>
  openUrl?(url: string): Promise<void>
  history(): Promise<BrowserHistoryEntry[]>
  removeHistory(id: string): Promise<void>
  downloads(): Promise<BrowserDownloadEntry[]>
  removeDownload(id: string): Promise<void>
  sites(): Promise<BrowserSitePermission[]>
  setSite(site: BrowserSitePermission): Promise<void>
  removeSite(origin: string): Promise<void>
  autofillStatus(): Promise<BrowserAutofillStatus>
  logins(): Promise<BrowserLoginMetadata[]>
  saveLogin(login: BrowserLoginInput): Promise<BrowserLoginMetadata>
  removeLogin(id: string): Promise<boolean>
  contacts(): Promise<BrowserContactMetadata[]>
  getContact(id: string): Promise<BrowserContact | null>
  saveContact(contact: BrowserContactInput): Promise<BrowserContactMetadata>
  removeContact(id: string): Promise<boolean>
  hooks: {
    /** Host-backed setting snapshot bound by the renderer. */
    snapshot: HostObservable<SettingsScopeSnapshot<BrowserSettings>>
  }
}

/** Props delivered by the Settings section outlet. */
export type BrowserSectionProps = PropsRuntime<'settings.section'>
  & PropsRenderSlots<'settings.browser.item'>
  & PropsLocale<'settings.browser'>
  & InjectFace<BrowserSectionInjected>

type Choice<T extends string = string> = { value: T; label: string }

interface ControlA11y {
  labelledBy: string
  describedBy: string
}

interface CollectionState<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: readonly T[]
  error?: string | undefined
}

interface SiteDraft {
  mode: 'add' | 'edit'
  origin: string
  access: BrowserSitePermission['access']
  media: BrowserSitePermission['media']
}

interface LoginDraft {
  mode: 'add' | 'edit'
  id?: string | undefined
  origin: string
  username: string
  password: string
}

interface ContactDraft {
  mode: 'add' | 'edit'
  id?: string | undefined
  label: string
  fields: BrowserContactFields
}

const contactFields = [
  ['name', 'browser.contactName'],
  ['givenName', 'browser.contactGivenName'],
  ['additionalName', 'browser.contactAdditionalName'],
  ['familyName', 'browser.contactFamilyName'],
  ['organization', 'browser.contactOrganization'],
  ['email', 'browser.contactEmail'],
  ['tel', 'browser.contactTelephone'],
  ['addressLine1', 'browser.contactAddressLine1'],
  ['addressLine2', 'browser.contactAddressLine2'],
  ['city', 'browser.contactCity'],
  ['region', 'browser.contactRegion'],
  ['postalCode', 'browser.contactPostalCode'],
  ['countryCode', 'browser.contactCountryCode'],
] as const satisfies ReadonlyArray<readonly [keyof BrowserContactFields, BrowserKey]>

const DEFAULT_SETTINGS: BrowserSettings = {
  controlEnabled: true,
  webDestination: 'hydra',
  localDestination: 'hydra',
  annotationScreenshots: 'include',
  downloadDirectory: '',
  askWhereToSave: false,
  navigationPolicy: 'ask',
  downloadPolicy: 'ask',
  uploadPolicy: 'ask',
  historyAccessPolicy: 'ask',
  fullCdpAccess: false,
}

function nativeSettings(settings: BrowserSettings): BrowserNativeSettings {
  return {
    webDestination: settings.webDestination,
    localDestination: settings.localDestination,
    annotationScreenshots: settings.annotationScreenshots,
    downloadDirectory: settings.downloadDirectory,
    askWhereToSave: settings.askWhereToSave,
    navigationPolicy: settings.browserPermissions?.browsing ?? settings.navigationPolicy,
    downloadPolicy: settings.browserPermissions?.downloads ?? settings.downloadPolicy,
    uploadPolicy: settings.browserPermissions?.uploads ?? settings.uploadPolicy,
    fullCdpAccess: settings.fullCdpAccess,
  }
}

function Toggle({ checked, disabled, onChange, a11y }: {
  checked: boolean
  disabled?: boolean
  onChange?: (next: boolean) => void
  a11y: ControlA11y
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-labelledby={a11y.labelledBy}
      aria-describedby={a11y.describedBy}
      aria-checked={checked}
      className={css.toggle}
      data-checked={checked || undefined}
      disabled={disabled}
      onClick={onChange === undefined ? undefined : () => { onChange(!checked) }}
    >
      <span className={css.toggleThumb} />
    </button>
  )
}

/**
 * Shared native dropdown using the Browser settings tokens.
 * @param props - selected value, choices, accessibility labels, and mutation callback.
 * @returns the labeled select control.
 */
function SelectControl<T extends string>({ value, choices, disabled, onChange, a11y }: {
  value: T
  choices: readonly Choice<T>[]
  disabled?: boolean
  onChange?: (value: T) => void
  a11y: ControlA11y
}) {
  return (
    <label className={css.selectWrap}>
      <select data-hydra-control="field"
        aria-labelledby={a11y.labelledBy}
        aria-describedby={a11y.describedBy}
        value={value}
        disabled={disabled}
        onChange={onChange === undefined ? undefined : (event) => { onChange(event.currentTarget.value as T) }}
      >
        {choices.map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}
      </select>
    </label>
  )
}

function Row({ title, description, children, disabled = false }: {
  title: string
  description: string
  children: (a11y: ControlA11y) => ReactNode
  disabled?: boolean
}) {
  const rowId = useId()
  const a11y = { labelledBy: `${rowId}-title`, describedBy: `${rowId}-description` }
  return (
    <div className={css.row} data-disabled={disabled || undefined}>
      <div className={css.rowCopy}>
        <div id={a11y.labelledBy} className={css.rowTitle}>{title}</div>
        <div id={a11y.describedBy} className={css.rowDescription}>{description}</div>
      </div>
      <div className={css.rowControl}>{children(a11y)}</div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={css.group}>
      <h3 className={css.groupTitle}>{title}</h3>
      <div className={css.card}>{children}</div>
    </section>
  )
}

function Action({ label, a11y, disabled = false, busy = false, onClick }: {
  label: string
  a11y?: ControlA11y
  disabled?: boolean
  busy?: boolean
  onClick?: () => void
}) {
  const labelId = useId()
  return (
    <button
      type="button"
      className={css.action}
      aria-labelledby={a11y === undefined ? undefined : `${a11y.labelledBy} ${labelId}`}
      aria-describedby={a11y?.describedBy}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span id={labelId}>{label}</span>
    </button>
  )
}

function SiteRows({
  entries, disabled, editLabel, removeLabel, emptyLabel, accessLabel, mediaLabel, allowLabel, blockLabel,
  onEdit, onRemove,
}: {
  entries: readonly BrowserSitePermission[]
  disabled: boolean
  editLabel: string
  removeLabel: string
  emptyLabel: string
  accessLabel: string
  mediaLabel: string
  allowLabel: string
  blockLabel: string
  onEdit: (site: BrowserSitePermission) => void
  onRemove: (origin: string) => void
}) {
  if (entries.length === 0) return <div className={css.emptySite}>{emptyLabel}</div>
  return (
    <ul className={css.siteList}>
      {entries.map(site => (
        <li className={css.siteRow} key={site.origin}>
          <div className={css.siteCopy}>
            <strong>{site.origin}</strong>
            <span>
              {`${accessLabel}: ${site.access === 'allow' ? allowLabel : blockLabel} · ${mediaLabel}: ${site.media === 'allow' ? allowLabel : blockLabel}`}
            </span>
          </div>
          <div className={css.listActions}>
            <button type="button" disabled={disabled} onClick={() => { onEdit(site) }}>
              {editLabel}
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-label={`${removeLabel} ${site.origin}`}
              onClick={() => { onRemove(site.origin) }}
            >
              {removeLabel}
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

const policyValues = ['allow', 'ask', 'block'] as const satisfies readonly BrowserPolicy[]

/** Render the Browser page shown only by the desktop shell. */
export function BrowserSection({
  renderSlot, setSetting, configureNative, pickDownloadDirectory, clearData,
  openUrl,
  history: listHistory, removeHistory, downloads: listDownloads, removeDownload,
  sites: listSites, setSite, removeSite, autofillStatus, logins: listLogins, saveLogin, removeLogin,
  contacts: listContacts, getContact, saveContact, removeContact, useSnapshot, t,
}: BrowserSectionProps) {
  const snapshot = useSnapshot(value => value)
  const settings = useMemo(
    () => ({ ...DEFAULT_SETTINGS, ...(snapshot.value ?? {}) }),
    [snapshot.value],
  )
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState<string | undefined>()
  const [fullCdpAccessAllowed, setFullCdpAccessAllowed] = useState<boolean | undefined>()
  const [manager, setManager] = useState<'history' | 'downloads' | 'sites' | 'logins' | 'contacts' | undefined>()
  const [clearOpen, setClearOpen] = useState(false)
  const [clearAcknowledged, setClearAcknowledged] = useState(false)
  const [clearScope, setClearScope] = useState<BrowserClearDataScope>('all')
  const [historyQuery, setHistoryQuery] = useState('')
  const [downloadQuery, setDownloadQuery] = useState('')
  const [historyState, setHistoryState] = useState<CollectionState<BrowserHistoryEntry>>({
    status: 'idle', entries: [],
  })
  const [downloadState, setDownloadState] = useState<CollectionState<BrowserDownloadEntry>>({
    status: 'idle', entries: [],
  })
  const [siteState, setSiteState] = useState<CollectionState<BrowserSitePermission>>({
    status: 'idle', entries: [],
  })
  const [autofill, setAutofill] = useState<BrowserAutofillStatus>({ available: false })
  const [loginState, setLoginState] = useState<CollectionState<BrowserLoginMetadata>>({
    status: 'idle', entries: [],
  })
  const [contactState, setContactState] = useState<CollectionState<BrowserContactMetadata>>({
    status: 'idle', entries: [],
  })
  const [siteDraft, setSiteDraft] = useState<SiteDraft | undefined>()
  const [siteDraftError, setSiteDraftError] = useState<string | undefined>()
  const [siteFeedback, setSiteFeedback] = useState<string | undefined>()
  const [loginDraft, setLoginDraft] = useState<LoginDraft | undefined>()
  const [loginDraftError, setLoginDraftError] = useState<string | undefined>()
  const [contactDraft, setContactDraft] = useState<ContactDraft | undefined>()
  const [contactDraftError, setContactDraftError] = useState<string | undefined>()

  const unavailable = snapshot.status !== 'ready' || !snapshot.writable
  const busy = pending !== undefined
  const permissionId = useId()
  const permissions = settings.browserPermissions ?? {
    browsing: settings.navigationPolicy, downloads: settings.downloadPolicy, uploads: settings.uploadPolicy,
  }
  const permissionChoices: readonly Choice<BrowserPolicy>[] = [
    { value: 'ask', label: t('browser.requiresApproval') },
    { value: 'allow', label: t('browser.alwaysAllow') },
    { value: 'block', label: t('browser.block') },
  ]
  const autofillAvailable = typeof autofill.available === 'boolean' && autofill.available
  const autofillDescription = (description: string) => autofillAvailable
    ? description
    : `${description} ${autofill.reason ?? t('browser.autofillUnavailable')}`

  const actionChoices = useMemo<readonly Choice<BrowserPolicy>[]>(() => policyValues.map(value => ({
    value,
    label: value === 'allow' ? t('browser.alwaysAllow')
      : value === 'ask' ? t('browser.alwaysAsk') : t('browser.neverAllow'),
  })), [t])
  const destinationChoices = useMemo<readonly Choice<BrowserDestination>[]>(() => [
    { value: 'hydra', label: 'Hydra harness' },
    { value: 'system', label: t('browser.systemBrowser') },
  ], [t])
  const screenshotChoices = useMemo<readonly Choice<BrowserAnnotationScreenshots>[]>(() => [
    { value: 'include', label: t('browser.alwaysInclude') },
    { value: 'ask', label: t('browser.askEachTime') },
    { value: 'never', label: t('browser.neverInclude') },
  ], [t])
  const clearScopeChoices = useMemo<readonly Choice<BrowserClearDataScope>[]>(() => [
    { value: 'all', label: t('browser.clearAllData') },
    { value: 'history', label: t('browser.clearHistoryOnly') },
    { value: 'site-data', label: t('browser.clearSiteDataOnly') },
    { value: 'cache', label: t('browser.clearCacheOnly') },
    { value: 'downloads', label: t('browser.clearDownloadsOnly') },
  ], [t])
  const selectedClearScope = clearScopeChoices.find(choice => choice.value === clearScope)?.label ?? clearScope

  const loadHistory = useCallback(async () => {
    setHistoryState(current => ({ status: 'loading', entries: current.entries }))
    try {
      setHistoryState({ status: 'ready', entries: await listHistory() })
    } catch (reason) {
      setHistoryState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    }
  }, [listHistory])

  const loadDownloads = useCallback(async () => {
    setDownloadState(current => ({ status: 'loading', entries: current.entries }))
    try {
      setDownloadState({ status: 'ready', entries: await listDownloads() })
    } catch (reason) {
      setDownloadState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    }
  }, [listDownloads])

  const loadSites = useCallback(async (): Promise<readonly BrowserSitePermission[] | undefined> => {
    setSiteState(current => ({ status: 'loading', entries: current.entries }))
    try {
      const entries = await listSites()
      setSiteState({ status: 'ready', entries })
      return entries
    } catch (reason) {
      setSiteState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
      return undefined
    }
  }, [listSites])

  const loadLogins = useCallback(async () => {
    setLoginState(current => ({ status: 'loading', entries: current.entries }))
    try {
      setLoginState({ status: 'ready', entries: await listLogins() })
    } catch (reason) {
      setLoginState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    }
  }, [listLogins])

  const loadContacts = useCallback(async () => {
    setContactState(current => ({ status: 'loading', entries: current.entries }))
    try {
      setContactState({ status: 'ready', entries: await listContacts() })
    } catch (reason) {
      setContactState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    }
  }, [listContacts])

  useEffect(() => {
    if (snapshot.status !== 'ready') return
    let current = true
    setFullCdpAccessAllowed(undefined)
    void configureNative(nativeSettings(settings)).then((capabilities) => {
      if (current) setFullCdpAccessAllowed(capabilities.fullCdpAccessAllowed)
    }).catch((reason: unknown) => {
      if (current) {
        setFullCdpAccessAllowed(false)
        setError(String(reason))
      }
    })
    return () => { current = false }
  }, [
    configureNative, snapshot.status, settings.annotationScreenshots, settings.askWhereToSave,
    settings.downloadDirectory, settings.downloadPolicy, settings.fullCdpAccess,
    settings.localDestination, settings.navigationPolicy, settings.uploadPolicy, settings.webDestination, settings.browserPermissions,
  ])

  useEffect(() => {
    if (snapshot.status === 'ready') void loadSites()
  }, [loadSites, snapshot.status])

  useEffect(() => {
    if (snapshot.status !== 'ready') return
    let current = true
    void autofillStatus().then((status) => {
      if (current) setAutofill(status)
    }).catch(() => {
      if (current) setAutofill({ available: false })
    })
    return () => { current = false }
  }, [autofillStatus, snapshot.status])

  const saveSetting = useCallback(async <K extends keyof BrowserSettings,>(
    key: K,
    value: BrowserSettings[K],
  ) => {
    setPending(key)
    setError(undefined)
    try {
      await setSetting(key, value)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setPending(undefined)
    }
  }, [setSetting])

  const chooseDownloadDirectory = useCallback(async () => {
    setPending('downloadDirectory')
    setError(undefined)
    try {
      const path = await pickDownloadDirectory()
      if (path === null) return
      await setSetting('downloadDirectory', path)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setPending(undefined)
    }
  }, [pickDownloadDirectory, setSetting])

  const changeFullCdpAccess = useCallback(async (next: boolean) => {
    if (!next) {
      await saveSetting('fullCdpAccess', false)
      return
    }
    if (fullCdpAccessAllowed !== true) return
    setPending('fullCdpAccess')
    setError(undefined)
    try {
      if (await window.hydraDesktop?.browser.confirmFullCdpAccess?.() === true) {
        await setSetting('fullCdpAccess', true)
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setPending(undefined)
    }
  }, [fullCdpAccessAllowed, saveSetting, setSetting])

  const confirmClearData = useCallback(async () => {
    setPending('clearData')
    setError(undefined)
    try {
      await clearData(clearScope)
      if (clearScope === 'all' || clearScope === 'history') {
        setHistoryState({ status: 'ready', entries: [] })
      }
      if (clearScope === 'all' || clearScope === 'downloads') {
        setDownloadState({ status: 'ready', entries: [] })
      }
      setClearOpen(false)
      setClearAcknowledged(false)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setPending(undefined)
    }
  }, [clearData, clearScope])

  const deleteHistory = useCallback(async (id: string) => {
    setPending(`history:${id}`)
    try {
      await removeHistory(id)
      setHistoryState(current => ({
        status: 'ready', entries: current.entries.filter(entry => entry.id !== id),
      }))
    } catch (reason) {
      setHistoryState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    } finally {
      setPending(undefined)
    }
  }, [removeHistory])

  const reopenHistory = useCallback(async (
    entry: BrowserHistoryEntry,
    open: (url: string) => Promise<void>,
  ) => {
    setPending(`history:${entry.id}`)
    try {
      await open(entry.url)
      setManager(undefined)
    } catch (reason) {
      setHistoryState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    } finally {
      setPending(undefined)
    }
  }, [])

  const deleteDownload = useCallback(async (id: string) => {
    setPending(`download:${id}`)
    try {
      await removeDownload(id)
      setDownloadState(current => ({
        status: 'ready', entries: current.entries.filter(entry => entry.id !== id),
      }))
    } catch (reason) {
      setDownloadState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    } finally {
      setPending(undefined)
    }
  }, [removeDownload])

  const openSiteEditor = useCallback((site?: BrowserSitePermission) => {
    setManager(undefined)
    setSiteDraftError(undefined)
    setSiteDraft(site === undefined
      ? { mode: 'add', origin: '', access: 'block', media: 'block' }
      : { mode: 'edit', origin: site.origin, access: site.access, media: site.media })
  }, [])

  const saveSite = useCallback(async (event: FormEvent) => {
    event.preventDefault()
    if (siteDraft === undefined) return
    setPending('site')
    setSiteDraftError(undefined)
    try {
      await setSite({
        origin: siteDraft.origin.trim(), access: siteDraft.access, media: siteDraft.media,
      })
      await loadSites()
      setSiteDraft(undefined)
      setSiteFeedback(t('browser.siteSaved'))
    } catch (reason) {
      setSiteDraftError(String(reason))
    } finally {
      setPending(undefined)
    }
  }, [loadSites, setSite, siteDraft, t])

  const deleteSite = useCallback(async (origin: string) => {
    setPending(`site:${origin}`)
    setSiteFeedback(undefined)
    try {
      await removeSite(origin)
      await loadSites()
    } catch (reason) {
      setSiteState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    } finally {
      setPending(undefined)
    }
  }, [loadSites, removeSite])

  const openLoginEditor = useCallback((entry?: BrowserLoginMetadata) => {
    setManager(undefined)
    setLoginDraftError(undefined)
    setLoginDraft(entry === undefined
      ? { mode: 'add', origin: '', username: '', password: '' }
      : { mode: 'edit', id: entry.id, origin: entry.origin, username: entry.username, password: '' })
  }, [])

  const submitLogin = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (loginDraft === undefined) return
    const form = event.currentTarget
    setPending('login')
    setLoginDraftError(undefined)
    try {
      await saveLogin({
        ...(loginDraft.id === undefined ? {} : { id: loginDraft.id }),
        origin: loginDraft.origin.trim(),
        username: loginDraft.username,
        ...(loginDraft.password === '' ? {} : { password: loginDraft.password }),
      })
      const password = form.elements.namedItem('password')
      if (password instanceof HTMLInputElement) {
        password.value = ''
        password.defaultValue = ''
      }
      setLoginDraft(current => current === undefined ? current : { ...current, password: '' })
      setLoginDraft(undefined)
      await loadLogins()
      setManager('logins')
    } catch (reason) {
      const password = form.elements.namedItem('password')
      if (password instanceof HTMLInputElement) {
        password.value = ''
        password.defaultValue = ''
      }
      setLoginDraft(current => current === undefined ? current : { ...current, password: '' })
      setLoginDraftError(String(reason))
    } finally {
      setPending(undefined)
    }
  }, [loadLogins, loginDraft, saveLogin])

  const deleteLogin = useCallback(async (id: string) => {
    setPending(`login:${id}`)
    try {
      await removeLogin(id)
      await loadLogins()
    } catch (reason) {
      setLoginState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    } finally {
      setPending(undefined)
    }
  }, [loadLogins, removeLogin])

  const openContactEditor = useCallback(async (entry?: BrowserContactMetadata) => {
    setManager(undefined)
    setContactDraftError(undefined)
    if (entry === undefined) {
      setContactDraft({ mode: 'add', label: '', fields: {} })
      return
    }
    setPending(`contact:${entry.id}`)
    try {
      const contact = await getContact(entry.id)
      if (contact === null) throw new Error('saved contact does not exist')
      setContactDraft({ mode: 'edit', id: contact.id, label: contact.label, fields: contact.fields })
    } catch (reason) {
      setContactState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
      setManager('contacts')
    } finally {
      setPending(undefined)
    }
  }, [getContact])

  const submitContact = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (contactDraft === undefined) return
    const fields = Object.fromEntries(contactFields
      .map(([key]) => [key, contactDraft.fields[key]?.trim()])
      .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')) as BrowserContactFields
    setPending('contact')
    setContactDraftError(undefined)
    try {
      await saveContact({
        ...(contactDraft.id === undefined ? {} : { id: contactDraft.id }),
        label: contactDraft.label.trim(),
        fields,
      })
      setContactDraft(undefined)
      await loadContacts()
      setManager('contacts')
    } catch (reason) {
      setContactDraftError(String(reason))
    } finally {
      setPending(undefined)
    }
  }, [contactDraft, loadContacts, saveContact])

  const deleteContact = useCallback(async (id: string) => {
    setPending(`contact:${id}`)
    try {
      await removeContact(id)
      await loadContacts()
    } catch (reason) {
      setContactState(current => ({ status: 'error', entries: current.entries, error: String(reason) }))
    } finally {
      setPending(undefined)
    }
  }, [loadContacts, removeContact])

  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase()
  const filteredHistory = historyState.entries.filter(entry => normalizedHistoryQuery.length === 0
    || `${entry.title}\n${entry.url}`.toLocaleLowerCase().includes(normalizedHistoryQuery))
  const normalizedDownloadQuery = downloadQuery.trim().toLocaleLowerCase()
  const filteredDownloads = downloadState.entries.filter(entry => normalizedDownloadQuery.length === 0
    || `${entry.filename}\n${entry.url}\n${entry.path}`.toLocaleLowerCase().includes(normalizedDownloadQuery))

  return (
    <section className={css.section} aria-labelledby="settings-browser-title" aria-busy={busy}>
      <header className={css.intro}>
        <h2 id="settings-browser-title" className={css.title}>{t('browser.title')}</h2>
        <p className={css.description}>{t('browser.description')}</p>
      </header>

      <div className={css.card}>
        <Row title={t('browser.control')} description={t('browser.controlDescription')} disabled={unavailable}>
          {a11y => (
            <Toggle
              checked={settings.controlEnabled}
              disabled={unavailable || busy}
              onChange={(next) => { void saveSetting('controlEnabled', next) }}
              a11y={a11y}
            />
          )}
        </Row>
      </div>

      {snapshot.status === 'unavailable' && <p className={css.unavailable} role="status">{t('browser.unavailable')}</p>}
      {busy && <p className={css.unavailable} role="status">{t('browser.saving')}</p>}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}

      <section className={css.globalPermissions} aria-labelledby={`${permissionId}-title`}>
        <div className={css.intro}>
          <h3 className={css.groupTitle} id={`${permissionId}-title`}>{t('browser.globalPermissions')}</h3>
          <p className={css.description} id={`${permissionId}-description`}>{t('browser.globalPermissionsDescription')}</p>
        </div>
        <div className={css.permissionsGrid}>
          {(['browsing', 'downloads', 'uploads'] as const).map(capability => (
            <div className={css.permissionItem} key={capability}>
              <span id={`${permissionId}-${capability}`} className={css.rowTitle}>{t(`browser.${capability}`)}</span>
              <SelectControl
                value={permissions[capability]}
                choices={permissionChoices}
                disabled={unavailable || busy}
                onChange={(value) => { void saveSetting('browserPermissions', { ...permissions, [capability]: value }) }}
                a11y={{ labelledBy: `${permissionId}-${capability}`, describedBy: `${permissionId}-description` }}
              />
            </div>
          ))}
        </div>
      </section>

      <div className={css.browserItems} role="list">
        {renderSlot('settings.browser.item', {})}
      </div>

      <Group title={t('browser.general')}>
        <Row title={t('browser.webDestination')} description={t('browser.destinationDescription')} disabled={unavailable}>
          {a11y => (
            <SelectControl
              value={settings.webDestination}
              choices={destinationChoices}
              disabled={unavailable || busy}
              onChange={(value) => { void saveSetting('webDestination', value) }}
              a11y={a11y}
            />
          )}
        </Row>
        <Row title={t('browser.localDestination')} description={t('browser.localDestinationDescription')} disabled={unavailable}>
          {a11y => (
            <SelectControl
              value={settings.localDestination}
              choices={destinationChoices}
              disabled={unavailable || busy}
              onChange={(value) => { void saveSetting('localDestination', value) }}
              a11y={a11y}
            />
          )}
        </Row>
        <Row title={t('browser.clearScope')} description={t('browser.clearScopeDescription')} disabled={unavailable}>
          {a11y => (
            <SelectControl
              value={clearScope}
              choices={clearScopeChoices}
              disabled={unavailable || busy}
              onChange={setClearScope}
              a11y={a11y}
            />
          )}
        </Row>
        <Row title={t('browser.browsingData')} description={t('browser.browsingDataDescription')} disabled={unavailable}>
          {a11y => (
            <Action
              label={t('browser.clearData')}
              a11y={a11y}
              disabled={unavailable || busy}
              onClick={() => { setClearOpen(true) }}
            />
          )}
        </Row>
        <Row title={t('browser.browsingHistory')} description={t('browser.browsingHistoryDescription')} disabled={unavailable}>
          {a11y => (
            <Action
              label={t('browser.manage')}
              a11y={a11y}
              disabled={unavailable || busy}
              onClick={() => { setManager('history'); void loadHistory() }}
            />
          )}
        </Row>
        <Row title={t('browser.annotationScreenshots')} description={t('browser.annotationDescription')} disabled={unavailable}>
          {a11y => (
            <SelectControl
              value={settings.annotationScreenshots}
              choices={screenshotChoices}
              disabled={unavailable || busy}
              onChange={(value) => { void saveSetting('annotationScreenshots', value) }}
              a11y={a11y}
            />
          )}
        </Row>
      </Group>

      <Group title={t('browser.autofillPasswords')}>
        <Row
          title={t('browser.passwordManager')}
          description={autofillDescription(t('browser.passwordManagerDescription'))}
          disabled={unavailable || !autofillAvailable}
        >
          {a11y => (
            <Action
              label={t('browser.manage')}
              a11y={a11y}
              disabled={unavailable || busy || !autofillAvailable}
              onClick={() => { setManager('logins'); void loadLogins() }}
            />
          )}
        </Row>
        <Row
          title={t('browser.contactInfo')}
          description={autofillDescription(t('browser.contactInfoDescription'))}
          disabled={unavailable || !autofillAvailable}
        >
          {a11y => (
            <Action
              label={t('browser.manage')}
              a11y={a11y}
              disabled={unavailable || busy || !autofillAvailable}
              onClick={() => { setManager('contacts'); void loadContacts() }}
            />
          )}
        </Row>
      </Group>

      <Group title={t('browser.downloads')}>
        <Row
          title={t('browser.location')}
          description={settings.downloadDirectory || t('browser.locationDescription')}
          disabled={unavailable}
        >
          {a11y => (
            <Action
              label={t('browser.change')}
              a11y={a11y}
              disabled={unavailable || busy}
              busy={pending === 'downloadDirectory'}
              onClick={() => { void chooseDownloadDirectory() }}
            />
          )}
        </Row>
        <Row title={t('browser.askWhereToSave')} description={t('browser.askWhereToSaveDescription')} disabled={unavailable}>
          {a11y => (
            <Toggle
              checked={settings.askWhereToSave}
              disabled={unavailable || busy}
              onChange={(next) => { void saveSetting('askWhereToSave', next) }}
              a11y={a11y}
            />
          )}
        </Row>
        <Row title={t('browser.downloadHistory')} description={t('browser.downloadHistoryDescription')} disabled={unavailable}>
          {a11y => (
            <Action
              label={t('browser.manage')}
              a11y={a11y}
              disabled={unavailable || busy}
              onClick={() => { setManager('downloads'); void loadDownloads() }}
            />
          )}
        </Row>
      </Group>

      <div className={css.card}>
        <Row title={t('browser.siteSettings')} description={t('browser.siteSettingsDescription')} disabled={unavailable}>
          {a11y => (
            <Action
              label={t('browser.manage')}
              a11y={a11y}
              disabled={unavailable || busy}
              onClick={() => { setManager('sites'); void loadSites() }}
            />
          )}
        </Row>
        <Row title={t('browser.historyAccess')} description={t('browser.historyDescription')} disabled={unavailable}>
          {a11y => (
            <SelectControl
              value={settings.historyAccessPolicy}
              choices={actionChoices}
              disabled={unavailable || busy}
              onChange={(value) => { void saveSetting('historyAccessPolicy', value) }}
              a11y={a11y}
            />
          )}
        </Row>
      </div>

      <section className={css.sitePermissions}>
        <div className={css.siteHeading}>
          <div>
            <h3 className={css.groupTitle}>{t('browser.sitePermissions')}</h3>
            <p className={css.siteDescription}>{t('browser.sitePermissionsDescription')}</p>
          </div>
          <Action
            label={`+ ${t('browser.add')}`}
            disabled={unavailable || busy}
            onClick={() => { openSiteEditor() }}
          />
        </div>
        {siteFeedback !== undefined && <p className={css.feedback} role="status">{siteFeedback}</p>}
        {siteState.status === 'idle' || siteState.status === 'loading'
          ? <p className={css.managerStatus}>{t('browser.loading')}</p>
          : null}
        {siteState.status === 'error' ? (
          <div className={css.managerError}>
            <p role="alert">{siteState.error}</p>
            <button type="button" onClick={() => { void loadSites() }}>{t('browser.retry')}</button>
          </div>
        ) : null}
        {siteState.status === 'ready' ? (
          <SiteRows
            entries={siteState.entries}
            disabled={unavailable || busy}
            editLabel={t('browser.edit')}
            removeLabel={t('browser.remove')}
            emptyLabel={t('browser.noSiteOverrides')}
            accessLabel={t('browser.siteAccess')}
            mediaLabel={t('browser.siteMedia')}
            allowLabel={t('browser.allow')}
            blockLabel={t('browser.block')}
            onEdit={openSiteEditor}
            onRemove={(origin) => { void deleteSite(origin) }}
          />
        ) : null}
      </section>

      <section className={css.developer}>
        <h3 className={css.groupTitle}>{t('browser.developerMode')}</h3>
        <div className={css.card}>
          <Row
            title={t('browser.fullCdp')}
            description={`${t('browser.fullCdpDescription')}${fullCdpAccessAllowed === false ? ` ${t('browser.fullCdpLocked')}` : ''}`}
            disabled={unavailable || fullCdpAccessAllowed !== true}
          >
            {a11y => (
              <Toggle
                checked={settings.fullCdpAccess}
                disabled={unavailable || busy || fullCdpAccessAllowed !== true}
                onChange={(next) => { void changeFullCdpAccess(next) }}
                a11y={a11y}
              />
            )}
          </Row>
        </div>
      </section>

      <RiskConfirmation
        open={clearOpen}
        title={t('browser.clearTitle')}
        description={`${t('browser.clearWarning')} ${t('browser.clearSelection')}: ${selectedClearScope}.`}
        acknowledgeLabel={t('browser.clearAcknowledge')}
        cancelLabel={t('browser.cancel')}
        confirmLabel={t('browser.clearData')}
        acknowledged={clearAcknowledged}
        disabled={busy}
        onAcknowledgedChange={setClearAcknowledged}
        onCancel={() => { if (!busy) { setClearOpen(false); setClearAcknowledged(false) } }}
        onConfirm={() => { void confirmClearData() }}
      />

      <Modal
        open={manager === 'history'}
        onClose={() => { setManager(undefined) }}
        title={t('browser.browsingHistory')}
        closeLabel={t('browser.close')}
        className={css.managerDialog ?? ''}
        contentClassName={css.managerContent ?? ''}
      >
        <label className={css.search}>
          <span>{t('browser.searchHistory')}</span>
          <input data-hydra-control="field"
            type="search"
            value={historyQuery}
            onChange={(event) => { setHistoryQuery(event.currentTarget.value) }}
          />
        </label>
        {historyState.status === 'loading' && <p className={css.managerStatus}>{t('browser.loading')}</p>}
        {historyState.status === 'error' ? (
          <div className={css.managerError}>
            <p role="alert">{historyState.error}</p>
            <button type="button" onClick={() => { void loadHistory() }}>{t('browser.retry')}</button>
          </div>
        ) : null}
        {historyState.status === 'ready' && filteredHistory.length === 0
          ? <p className={css.managerStatus}>{t('browser.noHistory')}</p>
          : null}
        {historyState.status === 'ready' && filteredHistory.length > 0 ? (
          <ul className={css.managerList}>
            {filteredHistory.map(entry => (
              <li key={entry.id}>
                <div className={css.managerCopy}>
                  <strong>{entry.title || entry.url}</strong>
                  <span>{entry.url}</span>
                  <time dateTime={entry.visitedAt}>{entry.visitedAt}</time>
                </div>
                <div className={css.listActions}>
                  {openUrl === undefined ? null : (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`${t('browser.open')} ${entry.title || entry.url}`}
                      onClick={() => { void reopenHistory(entry, openUrl) }}
                    >
                      {t('browser.open')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${t('browser.remove')} ${entry.title || entry.url}`}
                    onClick={() => { void deleteHistory(entry.id) }}
                  >
                    {t('browser.remove')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>

      <Modal
        open={manager === 'downloads'}
        onClose={() => { setManager(undefined) }}
        title={t('browser.downloadHistory')}
        closeLabel={t('browser.close')}
        className={css.managerDialog ?? ''}
        contentClassName={css.managerContent ?? ''}
      >
        <label className={css.search}>
          <span>{t('browser.searchDownloads')}</span>
          <input data-hydra-control="field"
            type="search"
            value={downloadQuery}
            onChange={(event) => { setDownloadQuery(event.currentTarget.value) }}
          />
        </label>
        {downloadState.status === 'loading' && <p className={css.managerStatus}>{t('browser.loading')}</p>}
        {downloadState.status === 'error' ? (
          <div className={css.managerError}>
            <p role="alert">{downloadState.error}</p>
            <button type="button" onClick={() => { void loadDownloads() }}>{t('browser.retry')}</button>
          </div>
        ) : null}
        {downloadState.status === 'ready' && filteredDownloads.length === 0
          ? <p className={css.managerStatus}>{t('browser.noDownloads')}</p>
          : null}
        {downloadState.status === 'ready' && filteredDownloads.length > 0 ? (
          <ul className={css.managerList}>
            {filteredDownloads.map(entry => (
              <li key={entry.id}>
                <div className={css.managerCopy}>
                  <strong>{entry.filename}</strong>
                  <span>{entry.path}</span>
                  <span>{entry.state}</span>
                  <time dateTime={entry.startedAt}>{entry.endedAt ?? entry.startedAt}</time>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`${t('browser.remove')} ${entry.filename}`}
                  onClick={() => { void deleteDownload(entry.id) }}
                >
                  {t('browser.remove')}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>

      <Modal
        open={manager === 'logins'}
        onClose={() => { setManager(undefined) }}
        title={t('browser.passwordManager')}
        closeLabel={t('browser.close')}
        className={css.managerDialog ?? ''}
        contentClassName={css.managerContent ?? ''}
      >
        <div className={css.managerHeading}>
          <p>{t('browser.passwordManagerDescription')}</p>
          <Action label={`+ ${t('browser.add')}`} disabled={busy} onClick={() => { openLoginEditor() }} />
        </div>
        {loginState.status === 'loading' && <p className={css.managerStatus}>{t('browser.loading')}</p>}
        {loginState.status === 'error' ? (
          <div className={css.managerError}>
            <p role="alert">{loginState.error}</p>
            <button type="button" onClick={() => { void loadLogins() }}>{t('browser.retry')}</button>
          </div>
        ) : null}
        {loginState.status === 'ready' && loginState.entries.length === 0
          ? <p className={css.managerStatus}>{t('browser.noLogins')}</p>
          : null}
        {loginState.status === 'ready' && loginState.entries.length > 0 ? (
          <ul className={css.managerList}>
            {loginState.entries.map(entry => (
              <li key={entry.id}>
                <div className={css.managerCopy}>
                  <strong>{entry.origin}</strong>
                  <span>{entry.username}</span>
                </div>
                <div className={css.listActions}>
                  <button type="button" disabled={busy} onClick={() => { openLoginEditor(entry) }}>
                    {t('browser.edit')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${t('browser.remove')} ${entry.origin} ${entry.username}`}
                    onClick={() => { void deleteLogin(entry.id) }}
                  >
                    {t('browser.remove')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>

      <Modal
        open={loginDraft !== undefined}
        onClose={() => { if (!busy) setLoginDraft(undefined) }}
        title={t(loginDraft?.mode === 'edit' ? 'browser.editLogin' : 'browser.addLogin')}
        closeLabel={t('browser.close')}
        className={css.siteDialog ?? ''}
        footer={(
          <>
            <button type="button" className={css.action} disabled={busy} onClick={() => { setLoginDraft(undefined) }}>
              {t('browser.cancel')}
            </button>
            <button
              type="submit"
              form="browser-login-form"
              className={css.action}
              disabled={busy || loginDraft?.origin.trim() === '' || (loginDraft?.mode === 'add' && loginDraft.password === '')}
            >
              {busy ? t('browser.saving') : t('browser.save')}
            </button>
          </>
        )}
      >
        <form id="browser-login-form" className={css.siteForm} onSubmit={(event) => { void submitLogin(event) }}>
          <label>
            <span>{t('browser.loginOrigin')}</span>
            <input data-hydra-control="field"
              type="url"
              value={loginDraft?.origin ?? ''}
              disabled={busy}
              placeholder="https://example.com"
              onChange={(event) => {
                const origin = event.currentTarget.value
                setLoginDraft(current => current === undefined ? current : { ...current, origin })
              }}
            />
          </label>
          <label>
            <span>{t('browser.loginUsername')}</span>
            <input data-hydra-control="field"
              value={loginDraft?.username ?? ''}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => {
                const username = event.currentTarget.value
                setLoginDraft(current => current === undefined ? current : { ...current, username })
              }}
            />
          </label>
          <label>
            <span>{t('browser.loginPassword')}</span>
            <input data-hydra-control="field"
              name="password"
              type="password"
              value={loginDraft?.password ?? ''}
              disabled={busy}
              autoComplete="new-password"
              onChange={(event) => {
                const password = event.currentTarget.value
                setLoginDraft(current => current === undefined ? current : { ...current, password })
              }}
            />
          </label>
          {loginDraft?.mode === 'edit' && <p className={css.managerStatus}>{t('browser.passwordKeepExisting')}</p>}
          {loginDraftError !== undefined && <p className={css.error} role="alert">{loginDraftError}</p>}
        </form>
      </Modal>

      <Modal
        open={manager === 'contacts'}
        onClose={() => { setManager(undefined) }}
        title={t('browser.contactInfo')}
        closeLabel={t('browser.close')}
        className={css.managerDialog ?? ''}
        contentClassName={css.managerContent ?? ''}
      >
        <div className={css.managerHeading}>
          <p>{t('browser.contactInfoDescription')}</p>
          <Action label={`+ ${t('browser.add')}`} disabled={busy} onClick={() => { void openContactEditor() }} />
        </div>
        {contactState.status === 'loading' && <p className={css.managerStatus}>{t('browser.loading')}</p>}
        {contactState.status === 'error' ? (
          <div className={css.managerError}>
            <p role="alert">{contactState.error}</p>
            <button type="button" onClick={() => { void loadContacts() }}>{t('browser.retry')}</button>
          </div>
        ) : null}
        {contactState.status === 'ready' && contactState.entries.length === 0
          ? <p className={css.managerStatus}>{t('browser.noContacts')}</p>
          : null}
        {contactState.status === 'ready' && contactState.entries.length > 0 ? (
          <ul className={css.managerList}>
            {contactState.entries.map(entry => (
              <li key={entry.id}>
                <div className={css.managerCopy}><strong>{entry.label}</strong></div>
                <div className={css.listActions}>
                  <button type="button" disabled={busy} onClick={() => { void openContactEditor(entry) }}>
                    {t('browser.edit')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${t('browser.remove')} ${entry.label}`}
                    onClick={() => { void deleteContact(entry.id) }}
                  >
                    {t('browser.remove')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>

      <Modal
        open={contactDraft !== undefined}
        onClose={() => { if (!busy) setContactDraft(undefined) }}
        title={t(contactDraft?.mode === 'edit' ? 'browser.editContact' : 'browser.addContact')}
        closeLabel={t('browser.close')}
        className={css.contactDialog ?? ''}
        contentClassName={css.managerContent ?? ''}
        footer={(
          <>
            <button type="button" className={css.action} disabled={busy} onClick={() => { setContactDraft(undefined) }}>
              {t('browser.cancel')}
            </button>
            <button
              type="submit"
              form="browser-contact-form"
              className={css.action}
              disabled={busy || contactDraft?.label.trim() === ''
                || !contactFields.some(([field]) => {
                  const value = contactDraft?.fields[field]
                  return value !== undefined && value.trim() !== ''
                })}
            >
              {busy ? t('browser.saving') : t('browser.save')}
            </button>
          </>
        )}
      >
        <form id="browser-contact-form" className={css.contactForm} onSubmit={(event) => { void submitContact(event) }}>
          <label className={css.fullField}>
            <span>{t('browser.contactLabel')}</span>
            <input data-hydra-control="field"
              value={contactDraft?.label ?? ''}
              disabled={busy}
              onChange={(event) => {
                const label = event.currentTarget.value
                setContactDraft(current => current === undefined ? current : { ...current, label })
              }}
            />
          </label>
          {contactFields.map(([field, key]) => (
            <label key={field}>
              <span>{t(key)}</span>
              <input data-hydra-control="field"
                value={contactDraft?.fields[field] ?? ''}
                disabled={busy}
                maxLength={field === 'countryCode' ? 2 : undefined}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setContactDraft(current => current === undefined ? current : {
                    ...current, fields: { ...current.fields, [field]: value },
                  })
                }}
              />
            </label>
          ))}
          {contactDraftError !== undefined && <p className={`${css.error} ${css.fullField}`} role="alert">{contactDraftError}</p>}
        </form>
      </Modal>

      <Modal
        open={manager === 'sites'}
        onClose={() => { setManager(undefined) }}
        title={t('browser.siteSettings')}
        closeLabel={t('browser.close')}
        className={css.managerDialog ?? ''}
        contentClassName={css.managerContent ?? ''}
      >
        {/* jscpd:ignore-start -- inline and modal site managers intentionally mirror the same controls. */}
        <div className={css.managerHeading}>
          <p>{t('browser.sitePermissionsDescription')}</p>
          <Action label={`+ ${t('browser.add')}`} disabled={unavailable || busy} onClick={() => { openSiteEditor() }} />
        </div>
        {siteState.status === 'idle' || siteState.status === 'loading'
          ? <p className={css.managerStatus}>{t('browser.loading')}</p>
          : null}
        {siteState.status === 'error' ? (
          <div className={css.managerError}>
            <p role="alert">{siteState.error}</p>
            <button type="button" onClick={() => { void loadSites() }}>{t('browser.retry')}</button>
          </div>
        ) : null}
        {siteState.status === 'ready' ? (
          <SiteRows
            entries={siteState.entries}
            disabled={unavailable || busy}
            editLabel={t('browser.edit')}
            removeLabel={t('browser.remove')}
            emptyLabel={t('browser.noSiteOverrides')}
            accessLabel={t('browser.siteAccess')}
            mediaLabel={t('browser.siteMedia')}
            allowLabel={t('browser.allow')}
            blockLabel={t('browser.block')}
            onEdit={openSiteEditor}
            onRemove={(origin) => { void deleteSite(origin) }}
          />
        ) : null}
      </Modal>
      {/* jscpd:ignore-end */}

      <Modal
        open={siteDraft !== undefined}
        onClose={() => { if (!busy) setSiteDraft(undefined) }}
        title={t(siteDraft?.mode === 'edit' ? 'browser.editSite' : 'browser.addSite')}
        closeLabel={t('browser.close')}
        className={css.siteDialog ?? ''}
        footer={(
          <>
            <button type="button" className={css.action} disabled={busy} onClick={() => { setSiteDraft(undefined) }}>
              {t('browser.cancel')}
            </button>
            <button
              type="submit"
              form="browser-site-form"
              className={css.action}
              disabled={unavailable || busy || siteDraft?.origin.trim().length === 0}
            >
              {busy ? t('browser.saving') : t('browser.save')}
            </button>
          </>
        )}
      >
        <form id="browser-site-form" className={css.siteForm} onSubmit={(event) => { void saveSite(event) }}>
          <label>
            <span>{t('browser.siteOrigin')}</span>
            <input data-hydra-control="field"
              value={siteDraft?.origin ?? ''}
              disabled={unavailable || busy || siteDraft?.mode === 'edit'}
              placeholder="https://example.com"
              onChange={(event) => {
                const origin = event.currentTarget.value
                setSiteDraft(current => current === undefined ? current : { ...current, origin })
              }}
            />
          </label>
          <label>
            <span>{t('browser.siteAccess')}</span>
            <select data-hydra-control="field"
              value={siteDraft?.access ?? 'block'}
              disabled={unavailable || busy}
              onChange={(event) => {
                const access = event.currentTarget.value as BrowserSitePermission['access']
                setSiteDraft(current => current === undefined ? current : { ...current, access })
              }}
            >
              <option value="allow">{t('browser.allow')}</option>
              <option value="block">{t('browser.block')}</option>
            </select>
          </label>
          <label>
            <span>{t('browser.siteMedia')}</span>
            <select data-hydra-control="field"
              value={siteDraft?.media ?? 'block'}
              disabled={unavailable || busy}
              onChange={(event) => {
                const media = event.currentTarget.value as BrowserSitePermission['media']
                setSiteDraft(current => current === undefined ? current : { ...current, media })
              }}
            >
              <option value="allow">{t('browser.allow')}</option>
              <option value="block">{t('browser.block')}</option>
            </select>
          </label>
          {siteDraftError !== undefined && <p className={css.error} role="alert">{siteDraftError}</p>}
        </form>
      </Modal>
    </section>
  )
}
