import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  IconChevronRightOutline14,
  IconCodeOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconRefreshOutline14,
} from '@bosch/bh-client-ui-primitives'
import css from './DesktopFilesPanel.module.css'

export interface DesktopFileEntry {
  name: string
  path: string
  directory: boolean
}

export interface DesktopFilesApi {
  root(): Promise<string>
  list(path?: string): Promise<DesktopFileEntry[]>
  read(path: string): Promise<{ path: string; content: string }>
}

function fileName(path: string): string {
  return path.replace(/[/\\]+$/u, '').split(/[/\\]/u).pop() ?? path
}

function relativePath(root: string, path: string): string {
  return path.slice(root.replace(/[/\\]+$/u, '').length).replace(/^[/\\]+/u, '') || fileName(root)
}

/** Read-only workspace tree and text preview backed by the desktop bridge. */
export function DesktopFilesPanel() {
  const api = window.bhDesktop?.files
  const [rootPath, setRootPath] = useState<string>()
  const [children, setChildren] = useState<Record<string, DesktopFileEntry[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string>()
  const [content, setContent] = useState('')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const loadDirectory = useCallback(async (path: string) => {
    if (api === undefined || rootPath === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      const entries = await api.list(path)
      setChildren(current => ({ ...current, [path]: entries }))
    } catch (reason) {
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }, [api, rootPath])

  useEffect(() => {
    if (api === undefined) return
    void api.root().then(setRootPath).catch((reason: unknown) => { setError(String(reason)) })
  }, [api])

  useEffect(() => {
    setChildren({})
    setSelected(undefined)
    setContent('')
    setError(undefined)
    if (rootPath === undefined) {
      setExpanded(new Set())
      return
    }
    setExpanded(new Set([rootPath]))
    void loadDirectory(rootPath)
  }, [loadDirectory, rootPath])

  const toggleDirectory = (path: string) => {
    const opening = !expanded.has(path)
    setExpanded((current) => {
      const next = new Set(current)
      if (opening) next.add(path)
      else next.delete(path)
      return next
    })
    if (opening && children[path] === undefined) void loadDirectory(path)
  }

  const openFile = async (path: string) => {
    if (api === undefined || rootPath === undefined) return
    setSelected(path)
    setLoading(true)
    setError(undefined)
    try {
      setContent((await api.read(path)).content)
    } catch (reason) {
      setContent('')
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }

  const renderDirectory = (path: string, depth: number): ReactNode => (
    children[path]?.map((entry) => {
      const open = entry.directory && expanded.has(entry.path)
      return (
        <div key={entry.path} role="treeitem" aria-expanded={entry.directory ? open : undefined}>
          <button
            type="button"
            className={css.row}
            style={{ paddingLeft: 8 + depth * 14 }}
            data-selected={!entry.directory && selected === entry.path || undefined}
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
              : <IconCodeOutline16 size={14} />}
            <span className={css.name}>{entry.name}</span>
          </button>
          {open && renderDirectory(entry.path, depth + 1)}
        </div>
      )
    }) ?? null
  )

  if (rootPath === undefined) {
    return <div className={css.empty}>Open a workspace to browse its files.</div>
  }

  return (
    <div className={css.surface} data-files-root={rootPath}>
      <aside className={css.treePane}>
        <header className={css.treeHeader}>
          <span title={rootPath}>{fileName(rootPath)}</span>
          <button type="button" aria-label="Refresh files" onClick={() => { void loadDirectory(rootPath) }}>
            <IconRefreshOutline14 />
          </button>
        </header>
        <div className={css.tree} role="tree" aria-label="Workspace files">
          {renderDirectory(rootPath, 0)}
        </div>
      </aside>
      <section className={css.editor} aria-label="File preview">
        <header className={css.editorHeader}>{selected === undefined ? 'Open file' : relativePath(rootPath, selected)}</header>
        {selected === undefined
          ? <div className={css.empty}>Select a file from the workspace tree.</div>
          : <pre className={css.code}><code>{content}</code></pre>}
        {loading && <span className={css.status}>Loading…</span>}
        {error !== undefined && <div className={css.error}>{error}</div>}
      </section>
    </div>
  )
}
