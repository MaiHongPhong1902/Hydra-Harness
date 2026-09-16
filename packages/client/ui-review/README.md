# Review UI

The Review tab in the desktop right panel and the inline Write/Edit rows display the same persisted [file review](../../fs/fs-review/README.md) records. The panel resolves its workspace from the mounted session and workspace runtime; it never assumes a repository path, branch, or file count. Rows retain each sequential edit, show A/M/D status, line counts, recorded hunks, tool/session attribution and child-session lineage. Keep preserves an already-applied change; Undo requests host-side hash validation and restoration. Neither action reads Git.

The object layer coalesces history reads and shares action state across the panel and inline entries. Host notifications and reconnects refresh committed history. Conflicts, unavailable snapshots and transport failures stay visible; no action optimistically removes evidence.

The scope selector also reads uncommitted, unstaged, staged, committed and branch diffs from the session host. Branch and commit choices come from that repository. The file tree, search, single-file navigation, unified/split layout, word highlighting, whitespace filtering and full-file context apply to these comparisons. Copy patch exports complete text patches; binary or limited previews disable it. Refresh preserves the selected comparison. Git comparisons never offer Keep or Undo.

The Session summary utility beside Session log opens a compact, anchored, nonmodal popover for the selected session. Environment provides refresh; Changes starts collapsed with colored additions and deletions, then exposes the active comparison, file and line totals, and session edits. Local exposes the workspace, session, status, agent preset, and host metadata; the branch row exposes the repository and recent commits. Commit or push and Create pull request remain disabled because Hydra has no Git mutation API. Sources previews the first three attached files or images and offers `View all (N)` for the loaded history; an incomplete history is identified as partial. A Subagents row appears when child sessions exist. The summary uses the shared ReviewHistory active comparison and framework-bound session, workspace, and host hooks.

Loading, unavailable, and error states stay explicit. Repository and branch details show loading or unavailable text, a Git-free workspace says so, and change counts remain absent until review data is ready; missing data never becomes a zero count.

## Model Experience

None, as this plugin renders stored review evidence without modifying model requests.

#### KV Cache effect

None; no model request is assembled here.

## Known Limitations and Deferred Work

- The panel includes child-session records by runtime metadata. Inline entries show changes for their exact session/tool calls. Shell/external-editor changes do not produce review records.
- Binary and large-file previews follow the host limits; incomplete snapshots cannot offer Undo.
- The Review panel mounts in the desktop right panel and the browser-only frame keeps the inline rows; Session summary is a session-header utility. Git comparisons require Git on the session host. A plain folder still supports persisted agent evidence. Commit, push, staging, rich previews and review comments are not implemented in this panel.
