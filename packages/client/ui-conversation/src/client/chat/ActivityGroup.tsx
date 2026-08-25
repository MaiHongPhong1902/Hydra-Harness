/** Compact aggregate disclosure for consecutive assistant activity rows. */
import { useState, type ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconChevronDownOutline14, IconEditOutline16, IconSparkle16,
} from '@bosch/bh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ActivityGroup.module.css'

/** Presentation family used by the aggregate activity header. */
export type ActivityKind = 'commands' | 'image' | 'read' | 'read-commands' | 'write' | 'other'

/** Map a wire tool name to the activity family a reader sees in the transcript. */
export function activityKindForTool(toolName: string): Exclude<ActivityKind, 'read-commands'> {
  const name = toolName.toLowerCase()
  if (name === 'read_image' || name === 'view_image' || name.includes('image')) return 'image'
  if (name === 'bash' || name === 'pwsh' || name === 'run_code' || name === 'skill' || name.startsWith('browser_')) return 'commands'
  if (name === 'read' || name === 'grep' || name === 'glob' || name.startsWith('read_')
    || name.includes('search') || name.includes('fetch')
    || name === 'obsidian_knowledge_recall' || name.startsWith('obsidian_knowledge_read')) return 'read'
  if (name === 'write' || name === 'edit' || name.startsWith('write_') || name.startsWith('edit_')) return 'write'
  // Unknown tool names are still executable activity; keep the header useful
  // when a persisted result no longer carries its original call metadata.
  return 'commands'
}

/** Fold the families in one consecutive run into one compact header label. */
export function activityKindForTools(toolNames: readonly string[]): ActivityKind {
  const kinds = new Set(toolNames.map(activityKindForTool))
  if (kinds.size === 1) return [...kinds][0] ?? 'other'
  if (kinds.size === 2 && kinds.has('read') && kinds.has('commands')) return 'read-commands'
  return 'other'
}

function titleFor(kind: ActivityKind, t: ChatViewSlotProps['t']): string {
  switch (kind) {
    case 'commands': return t('activity.ranCommands')
    case 'image': return t('activity.viewedImage')
    case 'read': return t('activity.readFiles')
    case 'read-commands': return t('activity.readFilesRanCommands')
    case 'write': return t('activity.updatedFiles')
    default: return t('activity.ranTools')
  }
}

function iconFor(kind: ActivityKind): ReactNode {
  switch (kind) {
    case 'image':
    case 'read':
      return <IconBrowseOutline16 size={14} />
    case 'write':
      return <IconEditOutline16 size={14} />
    case 'commands':
    case 'read-commands':
      return <IconApiOutline14 size={14} />
    default:
      return <IconSparkle16 size={14} />
  }
}

export interface ActivityGroupProps {
  /** Aggregate family shown in the header. */
  kind: ActivityKind
  /** Conversation locale seat. */
  t: ChatViewSlotProps['t']
  /** Existing keyed rows or image gallery; kept mounted while collapsed. */
  children: ReactNode
  /** The reference design shows active groups open; callers may opt out. */
  defaultOpen?: boolean | undefined
}

/** One screenshot-style activity header with a collapsible existing body. */
export function ActivityGroup({ kind, t, children, defaultOpen = true }: ActivityGroupProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className={css.root}
      data-chat-activity-group={kind}
      data-open={open || undefined}
    >
      <button
        type="button"
        className={css.row}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.leading}>{iconFor(kind)}</span>
        <span className={css.title}>{titleFor(kind, t)}</span>
        <IconChevronDownOutline14 className={css.chevron} />
      </button>
      <div
        className={css.children}
        data-activity-children
        data-collapsed={!open || undefined}
        aria-hidden={!open}
      >
        {children}
      </div>
    </div>
  )
}
