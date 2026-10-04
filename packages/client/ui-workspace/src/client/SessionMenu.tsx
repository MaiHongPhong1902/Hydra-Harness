/** Session action groups shared by right-click and the row's overflow button. */
import {
  IconArchiveOutline20, IconBranchOutline16, IconCopyOutline16, IconEditOutline16,
  IconFolderClose16, IconListPenOutline16, IconShareOutline16, IconTrashOutline16,
} from '@hydraharness/harness-client-ui-primitives'
import type { MenuEntry } from '@hydraharness/harness-client-ui-primitives'
import type { WorkspaceBrowserProps } from './contract/slots.ts'

/** Browser-owned organization and clipboard actions for one non-blank session. */
export interface SessionMenuOptions {
  pinned: boolean
  unread: boolean
  cwd: string | undefined
  projectId: string | undefined
  sectionId: string | undefined
  projects: readonly { workspaceId: string; title: string }[]
  sections: readonly { id: string; title: string }[]
  onPin: () => void
  onUnread: () => void
  onProject: (id: string | null) => void
  onSection: (id: string | null) => void
  onNewSection: () => void
  onCopy: (kind: 'link' | 'markdown' | 'directory') => void
  onWindow: () => void
}

/**
 * Render an action glyph absent from the shared icon set.
 * @param props - the pin, unread or window glyph selector.
 * @returns a decorative SVG icon.
 */
export function SessionActionIcon({ kind }: { kind: 'pin' | 'unread' | 'window' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      {kind === 'pin' && <path d="m6 2 7 7-2 1-2-2-3 3-1-1 3-3-2-2zM5 11l-3 3" />}
      {kind === 'unread' && <><path d="M1.5 8s2-4 6.5-4 6.5 4 6.5 4-2 4-6.5 4S1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></>}
      {kind === 'window' && <><rect x="2" y="4" width="10" height="9" rx="2" /><path d="M6 4V2h8v8h-2" /></>}
    </svg>
  )
}

/**
 * Compose action groups from the current session's viewing state.
 * @param t - workspace translation seat.
 * @param options - optional extended organization actions.
 * @returns rows for the shared Menu primitive.
 */
export function sessionMenuItems(t: WorkspaceBrowserProps['t'], options?: SessionMenuOptions): MenuEntry[] {
  const rename = { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> }
  const fork = { id: 'fork', label: t('menu.fork'), icon: <IconBranchOutline16 /> }
  const archive = { id: 'archive', label: t('menu.archiveSession'), icon: <IconArchiveOutline20 size={16} /> }
  const remove = { id: 'delete', label: t('delete.session'), icon: <IconTrashOutline16 />, danger: true }
  if (options === undefined) return [rename, fork, archive, remove]
  return [
    { ...rename, hint: 'Alt+Ctrl+R' },
    { id: 'pin', label: t(options.pinned ? 'menu.unpin' : 'menu.pin'), icon: <SessionActionIcon kind="pin" />, hint: 'Alt+Ctrl+P' },
    { id: 'unread', label: t(options.unread ? 'menu.read' : 'menu.unread'), icon: <SessionActionIcon kind="unread" />, hint: 'Ctrl+Shift+U' },
    { id: 'project', label: t('menu.project'), icon: <IconFolderClose16 />, submenu: [
      ...options.projects.map(project => ({ id: `project:${project.workspaceId}`, label: project.title, icon: <IconFolderClose16 /> })),
      { id: 'project:none', label: t('menu.removeProject'), disabled: options.projectId === undefined },
    ] },
    { id: 'section', label: t('menu.section'), icon: <IconListPenOutline16 />, submenu: [
      ...options.sections.map(section => ({ id: `section:${section.id}`, label: section.title, icon: <IconListPenOutline16 /> })),
      { id: 'section:new', label: t('menu.newSection') },
      { id: 'section:none', label: t('menu.removeSection'), disabled: options.sectionId === undefined },
    ] },
    { id: 'organize-separator', type: 'separator' },
    { id: 'fork-group', label: t('menu.forkGroup'), icon: <IconBranchOutline16 />, submenu: [
      fork,
      { id: 'fork-worktree', label: t('menu.forkWorktree'), icon: <IconBranchOutline16 />, disabled: true, title: t('menu.worktreeUnavailable') },
    ] },
    { id: 'fork-separator', type: 'separator' },
    { id: 'share', label: t('menu.share'), icon: <IconShareOutline16 />, disabled: true, hint: t('menu.comingSoon'), title: t('menu.comingSoon') },
    { id: 'copy', label: t('menu.copy'), icon: <IconCopyOutline16 />, submenu: [
      { id: 'copy:link', label: t('menu.copyLink'), icon: <IconCopyOutline16 />, hint: 'Alt+Ctrl+L' },
      { id: 'copy:markdown', label: t('menu.copyMarkdown'), icon: <IconCopyOutline16 /> },
      { id: 'copy:directory', label: t('menu.copyDirectory'), icon: <IconCopyOutline16 />, disabled: options.cwd === undefined, hint: 'Ctrl+Shift+C' },
    ] },
    { id: 'copy-separator', type: 'separator' },
    { id: 'window', label: t('menu.openWindow'), icon: <SessionActionIcon kind="window" /> },
    { id: 'window-separator', type: 'separator' },
    { ...archive, hint: 'Ctrl+Shift+A' },
    { ...remove, label: t('menu.deletePermanent') },
  ]
}
