import { useCallback, useDeferredValue, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  CodeBlock,
  IconBrowseOutline16,
  IconCheckOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconCodeOutline16,
  IconDataOutline16,
  IconEditOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconProjectAddOutline16,
  IconRefreshOutline14,
} from '@bosch/bh-client-ui-primitives'
import css from './DesktopFilesPanel.module.css'

export interface DesktopFileEntry {
  name: string
  path: string
  directory: boolean
}

export interface DesktopFilesApi {
  root(workspaceId: string): Promise<string>
  list(path: string, workspaceId: string): Promise<DesktopFileEntry[]>
  search(query: string, workspaceId: string): Promise<DesktopFileEntry[]>
  read(path: string, workspaceId: string): Promise<{ path: string; content: string; version: string }>
  create(
    parentPath: string,
    name: string,
    kind: 'file' | 'directory',
    workspaceId: string,
  ): Promise<DesktopFileEntry>
  save(
    path: string,
    content: string,
    expectedVersion: string,
    workspaceId: string,
  ): Promise<{ path: string; version: string }>
  format(path: string, content: string, workspaceId: string): Promise<string>
}

interface EditorDocument {
  path: string
  savedContent: string
  draft: string
  version: string
}

interface CreateDraft {
  parent: string
  kind: 'file' | 'directory'
}

type FileIconKind = 'code' | 'data' | 'web' | 'text'

const HIGHLIGHT_MAX_CHARS = 50_000
const EDITOR_LANGUAGE_ALIASES = new Map([
  ['mts', 'ts'], ['cts', 'ts'], ['mjs', 'js'], ['cjs', 'js'],
  ['h', 'c'], ['cc', 'cpp'], ['hpp', 'cpp'], ['cxx', 'cpp'],
  ['kt', 'kotlin'], ['markdown', 'md'], ['htm', 'html'],
])

function fileName(path: string): string {
  return path.replace(/[/\\]+$/u, '').split(/[/\\]/u).pop() ?? path
}

function editorLanguage(path: string): string | undefined {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const extension = name.slice(dot + 1).toLowerCase()
  return EDITOR_LANGUAGE_ALIASES.get(extension) ?? extension
}

function relativePath(root: string, path: string): string {
  return path.slice(root.replace(/[/\\]+$/u, '').length).replace(/^[/\\]+/u, '') || fileName(root)
}

function parentDirectory(root: string, path: string): string {
  const boundary = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = boundary < 0 ? root : path.slice(0, boundary)
  return parent.length < root.replace(/[/\\]+$/u, '').length ? root : parent
}

function fileIconKind(path: string): FileIconKind {
  const extension = fileName(path).split('.').pop()?.toLocaleLowerCase()
  if (extension !== undefined && ['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'csv'].includes(extension)) return 'data'
  if (extension !== undefined && ['html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte'].includes(extension)) return 'web'
  if (extension !== undefined && ['md', 'mdx', 'txt', 'rst'].includes(extension)) return 'text'
  return 'code'
}

function documentIsDirty(document: EditorDocument | undefined): boolean {
  return document !== undefined && document.draft !== document.savedContent
}

function FileIcon({ path }: { path: string }) {
  const kind = fileIconKind(path)
  return (
    <span className={css.fileIcon} data-file-icon={kind} aria-hidden="true">
      {kind === 'data' && <IconDataOutline16 size={14} />}
      {kind === 'web' && <IconBrowseOutline16 size={14} />}
      {kind === 'text' && <IconEditOutline16 size={14} />}
      {kind === 'code' && <IconCodeOutline16 size={14} />}
    </span>
  )
}

/** Workspace Explorer and guarded text editor backed by the desktop bridge. */
export function DesktopFilesPanel(props: {
  workspaceId?: string | undefined
  active: boolean
  focusSearch: number
  onDirtyChange?: ((dirty: boolean) => void) | undefined
  onSavingChange?: ((saving: boolean) => void) | undefined
}) {
  const api = window.bhDesktop?.files
  const { workspaceId } = props
  const searchRef = useRef<HTMLInputElement | null>(null)
  const createRef = useRef<HTMLInputElement | null>(null)
  const listRequests = useRef(new Map<string, number>())
  const readRequest = useRef(0)
  const handledFocusSearch = useRef(-1)
  const savingRef = useRef(false)
  const formattingRef = useRef(false)
  const mountedRef = useRef(true)
  const documentRef = useRef<EditorDocument>()
  const [rootPath, setRootPath] = useState<string>()
  const [children, setChildren] = useState<Record<string, DesktopFileEntry[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selectedDirectory, setSelectedDirectory] = useState<string>()
  const [document, setDocument] = useState<EditorDocument>()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<DesktopFileEntry[]>([])
  const [createDraft, setCreateDraft] = useState<CreateDraft>()
  const [createName, setCreateName] = useState('')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formatting, setFormatting] = useState(false)
  const deferredDraft = useDeferredValue(document?.draft)
  const dirty = documentIsDirty(document)
  const updateDocument = useCallback((update: (current: EditorDocument | undefined) => EditorDocument | undefined) => {
    if (!mountedRef.current) return
    const next = update(documentRef.current)
    documentRef.current = next
    setDocument(next)
    props.onDirtyChange?.(documentIsDirty(next))
  }, [props.onDirtyChange])

  const loadDirectory = useCallback(async (path: string) => {
    if (api === undefined || rootPath === undefined || workspaceId === undefined || !mountedRef.current) return
    const request = (listRequests.current.get(path) ?? 0) + 1
    listRequests.current.set(path, request)
    setLoading(true)
    setError(undefined)
    try {
      const entries = await api.list(path, workspaceId)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && listRequests.current.get(path) === request) {
        setChildren(current => ({ ...current, [path]: entries }))
      }
    } catch (reason) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && listRequests.current.get(path) === request) setError(String(reason))
    } finally {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && listRequests.current.get(path) === request) setLoading(false)
    }
  }, [api, rootPath, workspaceId])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (api === undefined || workspaceId === undefined) return
    let current = true
    void api.root(workspaceId).then(
      (path) => { if (current) setRootPath(path) },
      (reason: unknown) => { if (current) setError(String(reason)) },
    )
    return () => { current = false }
  }, [api, workspaceId])

  useEffect(() => {
    if (!props.active || rootPath === undefined || handledFocusSearch.current === props.focusSearch) return
    handledFocusSearch.current = props.focusSearch
    searchRef.current?.focus()
  }, [props.active, props.focusSearch, rootPath])

  useEffect(() => { createRef.current?.focus() }, [createDraft])

  useEffect(() => () => { props.onDirtyChange?.(false) }, [props.onDirtyChange])
  useEffect(() => () => { props.onSavingChange?.(false) }, [props.onSavingChange])

  useEffect(() => {
    setChildren({})
    updateDocument(() => undefined)
    setCreateDraft(undefined)
    setCreateName('')
    setError(undefined)
    if (rootPath === undefined) {
      setExpanded(new Set())
      setSelectedDirectory(undefined)
      return
    }
    setExpanded(new Set([rootPath]))
    setSelectedDirectory(rootPath)
    void loadDirectory(rootPath)
  }, [loadDirectory, rootPath, updateDocument])

  useEffect(() => {
    const value = query.trim()
    if (api === undefined || rootPath === undefined || workspaceId === undefined || value === '') {
      setMatches([])
      setSearching(false)
      return
    }
    let current = true
    setMatches([])
    setSearching(true)
    const timer = window.setTimeout(() => {
      void api.search(value, workspaceId).then(
        (entries) => { if (current) setMatches(entries) },
        (reason: unknown) => { if (current) { setMatches([]); setError(String(reason)) } },
      ).finally(() => { if (current) setSearching(false) })
    }, 150)
    return () => { current = false; window.clearTimeout(timer) }
  }, [api, query, rootPath, workspaceId])

  const toggleDirectory = (path: string) => {
    const opening = !expanded.has(path)
    setSelectedDirectory(path)
    setExpanded((current) => {
      const next = new Set(current)
      if (opening) next.add(path)
      else next.delete(path)
      return next
    })
    if (opening && children[path] === undefined) void loadDirectory(path)
  }

  const openFile = useCallback(async (path: string) => {
    if (api === undefined || rootPath === undefined || workspaceId === undefined
      || savingRef.current || !mountedRef.current) return
    const previous = documentRef.current
    if (previous?.path === path) return
    if (documentIsDirty(previous) && !window.confirm('Discard unsaved changes and open another file?')) return
    const request = ++readRequest.current
    setLoading(true)
    setError(undefined)
    try {
      const next = await api.read(path, workspaceId)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && readRequest.current === request) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- saving can start while the desktop request is pending.
        if (savingRef.current) return
        const latest = documentRef.current
        if (latest !== previous && documentIsDirty(latest)
          && !window.confirm('Discard unsaved changes and open another file?')) return
        updateDocument(() => ({ path: next.path, savedContent: next.content, draft: next.content, version: next.version }))
        setSelectedDirectory(parentDirectory(rootPath, next.path))
      }
    } catch (reason) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && readRequest.current === request) setError(String(reason))
    } finally {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refs can change while the desktop request is pending.
      if (mountedRef.current && readRequest.current === request) setLoading(false)
    }
  }, [api, rootPath, updateDocument, workspaceId])

  const startCreate = (kind: CreateDraft['kind']) => {
    if (rootPath === undefined) return
    setQuery('')
    setError(undefined)
    setCreateName('')
    setCreateDraft({ parent: selectedDirectory ?? rootPath, kind })
  }

  const submitCreate = async () => {
    if (api === undefined || createDraft === undefined || workspaceId === undefined || createName.trim() === '') return
    const documentAtSubmit = documentRef.current
    const readRequestAtSubmit = readRequest.current
    setCreating(true)
    setError(undefined)
    try {
      const entry = await api.create(createDraft.parent, createName, createDraft.kind, workspaceId)
      if (!mountedRef.current) return
      setExpanded(current => new Set(current).add(createDraft.parent))
      await loadDirectory(createDraft.parent)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- unmount can occur while the directory refresh is pending.
      if (!mountedRef.current) return
      setCreateDraft(undefined)
      setCreateName('')
      if (entry.directory) setSelectedDirectory(entry.path)
      else if (readRequest.current === readRequestAtSubmit
        && documentRef.current === documentAtSubmit && !documentIsDirty(documentRef.current)) {
        await openFile(entry.path)
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  const saveFile = useCallback(async () => {
    if (api === undefined || document === undefined || workspaceId === undefined || !dirty
      || savingRef.current || formattingRef.current) return
    const snapshot = document
    savingRef.current = true
    setSaving(true)
    props.onSavingChange?.(true)
    setError(undefined)
    try {
      const saved = await api.save(snapshot.path, snapshot.draft, snapshot.version, workspaceId)
      updateDocument(current => current?.path === snapshot.path
        ? { ...current, savedContent: snapshot.draft, version: saved.version }
        : current)
    } catch (reason) {
      setError(String(reason))
    } finally {
      savingRef.current = false
      if (mountedRef.current) {
        setSaving(false)
        props.onSavingChange?.(false)
      }
    }
  }, [api, dirty, document, props.onSavingChange, updateDocument, workspaceId])

  const formatFile = useCallback(async () => {
    if (api === undefined || document === undefined || workspaceId === undefined
      || formattingRef.current || savingRef.current) return
    const snapshot = document
    formattingRef.current = true
    setFormatting(true)
    setError(undefined)
    try {
      const formatted = await api.format(snapshot.path, snapshot.draft, workspaceId)
      updateDocument(current => current?.path === snapshot.path && current.draft === snapshot.draft
        ? { ...current, draft: formatted }
        : current)
    } catch (reason) {
      setError(String(reason))
    } finally {
      formattingRef.current = false
      if (mountedRef.current) setFormatting(false)
    }
  }, [api, document, updateDocument, workspaceId])

  useEffect(() => {
    if (!props.active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLocaleLowerCase()
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 's') {
        event.preventDefault()
        void saveFile()
      } else if (event.shiftKey && event.altKey && key === 'f') {
        event.preventDefault()
        void formatFile()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [formatFile, props.active, saveFile])

  const renderDirectory = (path: string, depth: number): ReactNode => (
    children[path]?.map((entry) => {
      const open = entry.directory && expanded.has(entry.path)
      return (
        <div key={entry.path} role="treeitem" aria-expanded={entry.directory ? open : undefined}>
          <button
            type="button"
            className={css.row}
            style={{ paddingLeft: 8 + depth * 14 }}
            data-selected={!entry.directory && document?.path === entry.path || undefined}
            onClick={() => {
              if (entry.directory) toggleDirectory(entry.path)
              else void openFile(entry.path)
            }}
          >
            {entry.directory
              ? <IconChevronRightOutline14 className={css.chevron} size={12} />
              : <span className={css.chevron} />}
            {entry.directory
              ? open ? <IconFolderOpen16 size={15} /> : <IconFolderClose16 size={15} />
              : <FileIcon path={entry.path} />}
            <span className={css.name}>{entry.name}</span>
          </button>
          {open && renderDirectory(entry.path, depth + 1)}
        </div>
      )
    }) ?? null
  )

  if (rootPath === undefined) {
    return <div className={css.empty}>{error ?? 'Open a workspace to browse its files.'}</div>
  }

  const status = saving
    ? 'Saving…'
    : formatting
      ? 'Formatting…'
      : creating
        ? 'Creating…'
        : searching
          ? 'Searching…'
          : loading
            ? 'Loading…'
            : undefined
  const language = document === undefined ? undefined : editorLanguage(document.path)
  // ponytail: keep large-file editing responsive; move Shiki to a worker if large-file highlighting becomes necessary.
  const highlightedDraft = document !== undefined && deferredDraft === document.draft
    && document.draft.length <= HIGHLIGHT_MAX_CHARS
    ? deferredDraft
    : undefined

  return (
    <div className={css.surface} data-files-root={rootPath}>
      <aside className={css.treePane}>
        <header className={css.treeHeader}>
          <span title={rootPath}>{fileName(rootPath)}</span>
          <div className={css.treeActions}>
            <button type="button" aria-label="New file" title="New file" onClick={() => { startCreate('file') }}>
              <IconPlusOutline16 size={14} />
            </button>
            <button type="button" aria-label="New folder" title="New folder" onClick={() => { startCreate('directory') }}>
              <IconProjectAddOutline16 size={14} />
            </button>
            <button type="button" aria-label="Refresh files" title="Refresh files" onClick={() => { void loadDirectory(rootPath) }}>
              <IconRefreshOutline14 />
            </button>
          </div>
        </header>
        <div className={css.filter}>
          <input
            ref={searchRef}
            type="search"
            aria-label="Filter workspace files"
            placeholder="Filter files…"
            value={query}
            onChange={(event) => { setQuery(event.currentTarget.value); setError(undefined) }}
          />
        </div>
        <div className={css.tree} role="tree" aria-label="Workspace files">
          {createDraft !== undefined && (
            <form
              className={css.createRow}
              title={`Create in ${relativePath(rootPath, createDraft.parent)}`}
              onSubmit={(event) => { event.preventDefault(); void submitCreate() }}
            >
              {createDraft.kind === 'directory' ? <IconFolderClose16 size={15} /> : <FileIcon path={createName} />}
              <input
                ref={createRef}
                aria-label={createDraft.kind === 'directory' ? 'New folder name' : 'New file name'}
                value={createName}
                disabled={creating}
                onChange={(event) => { setCreateName(event.currentTarget.value) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  setCreateDraft(undefined)
                  setCreateName('')
                }}
              />
              <button type="submit" aria-label={`Create ${createDraft.kind}`} disabled={creating || createName.trim() === ''}>
                <IconCheckOutline14 />
              </button>
              <button
                type="button"
                aria-label={`Cancel new ${createDraft.kind}`}
                disabled={creating}
                onClick={() => { setCreateDraft(undefined); setCreateName('') }}
              >
                <IconCloseOutline16 size={13} />
              </button>
            </form>
          )}
          {query.trim() === ''
            ? renderDirectory(rootPath, 0)
            : matches.map(entry => (
              <div key={entry.path} role="treeitem">
                <button
                  type="button"
                  className={css.row}
                  data-selected={document?.path === entry.path || undefined}
                  title={entry.name}
                  onClick={() => { void openFile(entry.path) }}
                >
                  <span className={css.chevron} />
                  <FileIcon path={entry.path} />
                  <span className={css.name}>{entry.name}</span>
                </button>
              </div>
            ))}
          {query.trim() !== '' && !searching && matches.length === 0 && (
            <div className={css.noResults}>No files found.</div>
          )}
        </div>
      </aside>
      <section className={css.editor} aria-label="File editor">
        <header className={css.editorHeader}>
          <span className={css.editorTitle} title={document?.path}>
            {document === undefined ? 'Open file' : relativePath(rootPath, document.path)}
            {dirty && <span className={css.dirty} aria-label="Unsaved changes">●</span>}
          </span>
          <div className={css.editorActions}>
            <Button
              variant="toolbar"
              size="sm"
              aria-keyshortcuts="Shift+Alt+F"
              disabled={document === undefined || formatting || saving}
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { void formatFile() }}
            >
              Format
            </Button>
            <Button
              variant="toolbar"
              size="sm"
              aria-keyshortcuts="Control+S"
              disabled={!dirty || saving || formatting}
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { void saveFile() }}
            >
              Save
            </Button>
          </div>
        </header>
        {document === undefined
          ? <div className={css.empty}>Select a text file from the workspace tree.</div>
          : (
            <div className={css.codeScroll}>
              <div className={css.codeCanvas}>
                <div
                  ref={node => node?.setAttribute('inert', '')}
                  className={css.codeSyntax}
                  data-editor-highlight={highlightedDraft === undefined ? 'plain' : language ?? 'plain'}
                  aria-hidden="true"
                >
                  {highlightedDraft === undefined
                    ? <pre className={css.codePlain}>{document.draft}{document.draft.endsWith('\n') && '\u200b'}</pre>
                    : (
                      <CodeBlock
                        code={`${highlightedDraft}${highlightedDraft.endsWith('\n') ? '\u200b' : ''}`}
                        lang={language}
                        className={css.codeHighlight}
                      />
                    )}
                </div>
                <textarea
                  className={css.code}
                  aria-label={`Editor for ${fileName(document.path)}`}
                  data-dirty={dirty || undefined}
                  spellCheck={false}
                  wrap="off"
                  value={document.draft}
                  onChange={(event) => {
                    const draft = event.currentTarget.value
                    updateDocument(current => current === undefined ? current : { ...current, draft })
                  }}
                />
              </div>
            </div>
          )}
        {status !== undefined && <span className={css.status} role="status" aria-live="polite">{status}</span>}
        {error !== undefined && <div className={css.error} role="alert">{error}</div>}
      </section>
    </div>
  )
}
