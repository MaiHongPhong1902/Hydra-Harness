# Reuse page workflows

Page memory helps the agent repeat work on the same website by saving a verified procedure: what to inspect, which controls to use, how to recognize success, and which pitfalls to avoid. Saved workflows remain available across sessions in the same workspace, role, and locale. Current page values and permissions still come from live Browser checks.

This guide assumes you have [built the desktop app](./desktop.md#build-and-launch) and [configured a model](./providers.md). The example uses a test form that you are authorized to submit.

## 1. Enable page memory

The shipped profile keeps page memory disabled until `HYDRA_PAGE_MEMORY_ROLE` is set. Open a controlled Browser page to start recall; it applies only to sessions in the configured workspace.

From the checkout root, start Desktop with an explicit application role. In PowerShell:

```powershell
$env:HYDRA_PAGE_MEMORY_ROLE = 'order-operator'
$env:HYDRA_PAGE_MEMORY_LOCALE = 'en-US'
pnpm run desktop
```

The shipped configuration uses the Host's starting directory as the page-memory workspace. Select that same directory in **Choose workspace**. A different workspace requires an explicit `workspaceDir` in the [plugin configuration](../../../packages/knowledge/page-memory/README.md#configuration).

Use a role label appropriate to your application; the label is not a login identity or a permission grant. Once the plugin is mounted, **Settings → Plugins → page-memory** exposes role, locale, storage, and verification limits. Saved settings apply after restarting Hydra.

## 2. Learn a successful workflow

Open the test form in Hydra's controlled Browser. Give the task a stable name such as `save_form`, and send:

> Use page_memory_get with task save_form on this page. Fill and save the form using the test values I provide, verify the success message, then save the reusable procedure with page_memory_upsert. Keep the field values out of memory.

On first use, `missing` means there is no saved workflow for that exact page and task. The agent inspects the current page and uses observed unique CSS selectors. A save requires a successful supported Browser action followed by a live outcome check in the same turn, task, tab, and current URL. Reading a page alone does not qualify as a verified save.

Check the tool result for `Page memory verified: save_form`. The saved workflow contains reusable steps, anchor text, selectors, a success check, and pitfalls. Save procedures only: do not include credentials, cookies, tokens, raw DOM, or task-specific customer or order values.

## 3. Reuse the workflow

Return to the same page in this session or a new session using the same workspace, role, and locale. Send:

> Use the saved save_form workflow on this page with the new values I provide. Check the page before acting and verify the result afterward.

The agent selects the exact task with `page_memory_get`; automatic recall then follows the current page. It rechecks saved anchors and selectors before returning instructions and checks the page again before acting. Each selector is read once within a verification pass; later passes use fresh Browser observations.

The task name must match exactly. Query strings and fragments remain distinct, including when configured route patterns share procedures across path parameters. Changing workspace, role, or locale selects a separate memory namespace.

## 4. Repair stale guidance

When the page changes, ask the agent to inspect the affected region, complete the task using current evidence, verify success, and replace the workflow with `page_memory_upsert`.

### Status reference

| Status | What to do |
| --- | --- |
| `select-task` | Choose an exact task with `page_memory_get`. |
| `missing` | Complete and verify the workflow before saving it. |
| `verified` | Reuse the procedure while continuing live page checks. |
| `stale` | Inspect the selector named in the diagnostic and learn the current procedure. |
| `loading` or `changed` | Let the page settle or read the current workflow again. |
| `unavailable` | Check Browser availability or requested approval, then use current observations. A transient read failure leaves the stored verification status unchanged. |
| `inactive` | Open a controlled Browser page. |
| `too-large` | Save a shorter procedure; partial instructions are not returned. |

Under the Browsing `ask` policy, approve an explicit `page_memory_get` read when requested. Background recall opens no approval dialog, and Browser actions retain their own approval checks.

## Memory and caching

Page memory reuses procedures, detects stale page instructions, and avoids adding identical guidance repeatedly to the conversation. Compaction can remove guidance from the active context; Hydra sends it again when needed. A restored log does not prove that a new model request has seen the guidance.

Hydra follows session events to track guidance still present in context, reducing repeated history scans during long sessions. Context replacements rebuild that tracking from the current conversation. This tracking preserves live Browser verification and does not itself increase provider prompt-cache hits.

Provider prompt caching is separate from local page-memory storage. A compact, stable procedure can reduce repeated input, but cache-hit rates, task latency, and API cost depend on the provider and workload. Saved memory is neither a cache of current business data nor authorization to act.

The [package reference](../../../packages/knowledge/page-memory/README.md), [tool schemas](../../tool-catalog.md#hydraharness-page-memory), and [configuration reference](../../config-catalog.md#hydraharness-page-memory) cover the detailed options and limits.
