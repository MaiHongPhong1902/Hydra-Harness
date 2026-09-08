# Review UI

The Review tab in the desktop right panel and the inline Write/Edit rows display the same persisted [file review](../../fs/fs-review/README.md) records. Rows retain each sequential edit, show A/M/D status, line counts, recorded hunks, tool/session attribution and child-session lineage. Keep preserves an already-applied change; Undo requests host-side hash validation and restoration. Neither action reads Git.

The object layer coalesces history reads and shares action state across the panel and inline entries. Host notifications and reconnects refresh committed history. Conflicts, unavailable snapshots and transport failures stay visible; no action optimistically removes evidence.

## Model Experience

None, as this plugin renders stored review evidence without modifying model requests.

#### KV Cache effect

None; no model request is assembled here.

## Known Limitations and Deferred Work

- The panel includes child-session records by runtime metadata. Inline entries show changes for their exact session/tool calls. Shell/external-editor changes do not produce review records.
- Binary and large-file previews follow the host limits; incomplete snapshots cannot offer Undo.
- The aggregated panel mounts only in the desktop right panel; the browser-only frame keeps the inline rows.
