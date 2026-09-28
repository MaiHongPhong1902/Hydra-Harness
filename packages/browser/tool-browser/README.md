# @hydraharness/harness-tool-browser

The model-facing half of the embedded browser: standard `browser_*` tools over controlled tabs, a selected-viewport screenshot, policy-gated history search, opt-in Full CDP controls, demoted `browser_page_agent_*` controls for the vendored ReAct engine, and the one browser prompt section. The user also has a native tab strip and omnibox; the window, the page, and the process live behind `ctx.browsers` in [@hydraharness/harness-browser-electron](../browser-electron/README.md).

The split is the usual consumer/seam one. Everything the model can see — schema wording, the accessibility-snapshot guidance, the character cap, the card titles — is decided here; nothing here knows that the browser is Electron.

## What one call returns

`browser_select_text` reports the completed selection in `action.selectedText` and the rendered action message. Element targets select their full contents; coordinate selection requires all four finite, non-negative CSS pixel coordinates.

Page action tools answer with the same object, and the model reads it as one text block: what the action did, the controlled tab list, the snapshot tab, then the accessibility tree it left behind. The structured value uses `tabId` for that snapshot and its valid refs, `activeTabId` for the tab selected in the visible chrome, plus `settled`, `capturedAt`, `truncated`, and `compact`. An exhausted readiness wait is transient evidence, not a UI verdict.

`browser_state` and navigation return a full numeric snapshot bounded by `maxStateChars` (default 16,000); ordinary actions return a compact 4,000-character snapshot or a smaller same-tab diff. Numeric indexes are preserved during filtering/ranking. Compact diffs classify up to 20 newly shown, hidden, expanded, collapsed, and changed controls, and report a newly focused control when available, so the model can inspect newly exposed content first. `browser_snapshot` uses Playwright's distilled tree, with optional `target`, `depth`, and `boxes`. A positive `depth` limits tree depth; zero or omission means unlimited. Its `[ref=e17]` addresses `target:"e17"`; a numeric `[17]` addresses `index:17`. The namespaces are independent. Click, hover, type, option/text selection, and form filling also accept unique CSS selectors through `target`.

`browser_find` accepts exactly one of `text`, `regex`, or the `query` text alias and returns snippets with observed Playwright refs. Find and console/network diagnostics omit trailing snapshots. Network lists accept a URL regex `filter`, keep stable request indexes, and feed `browser_network_request` for selected headers or bodies. Regex accepts a plain pattern or `/pattern/i`.

```
did navigate

Open tabs:
- [1] (active) Order — https://shop.test/order (complete)
Snapshot tab: [1]

Current Page: [Order](https://shop.test/order)
Page info: 1280x900px viewport, 1280x2400px total page size

Interactive elements from top layer of the current page inside the viewport:
[0]<textbox id=who>Requester</textbox>
[1]<button id=submit>Order</button>
... 1500 pixels below - scroll to see more ...
```

`snapshotMode:none` skips automatic page capture and returns native loading/dialog metadata with short verification guidance. Read `browser_state` before reusing numeric indexes; verify action effects with `browser_find` or scoped `browser_snapshot`. Suppressed, scoped, saved, truncated, and transient snapshots never establish an unseen diff baseline. Readiness and dialog notices survive omission.

An action the page rejects — a missing index, a `select` that has no such option — comes back as `{success: false, message}` rendered into that same text block, not as a tool error. It is a fact the model can act on, and raising it as an error would only cost a retry.

`browser_screenshot` and `browser_take_screenshot` capture the selected HTTP(S) viewport. Without omission they require image-capable routing and save PNG attachments before returning an image block. Supplying `filename`, or configuring `imageResponses:omit`, writes PNG evidence without attachment admission or model image input. Screenshot metadata and the returned path are logged; raw base64 never enters the session. Background tabs, browser chrome, crops, and full pages are unsupported.

`browser_snapshot`, console messages, and network list/detail also accept `filename`. A plain basename is saved in an exclusively created directory under `outputDir`; paths, reserved Windows names, and overwrite targets are rejected. The returned absolute path replaces the payload. Files retain the source output before the model's character cap; diagnostic retention still caps it at 64 Ki characters with an explicit notice. Failed diagnostics remain failures and create no file. Temporary artifacts are host-cleanable; copy required evidence into the final deliverable.

## Config

| key | default | effect |
| --- | --- | --- |
| `maxStateChars` | `16000` | Cap on the element list one call returns, matching `tool-str-replace-editor`'s `maxOutputChars`. |
| `timeoutMs` | `60000` | Cooperative tool-call budget for one browser action. |
| `snapshotMode` | `full` | `none` omits automatic page snapshots; explicit reads remain available. |
| `imageResponses` | `allow` | `omit` saves screenshots without image blocks. |
| `consoleLevel` | `error` | Default diagnostic severity, overridable per call. |
| `outputDir` | OS temp directory + `hydra-browser-output` | Absolute root for private per-call artifacts. |

`experimentalScriptExecution` belongs to `@hydraharness/harness-browser-electron`, not this consumer. When the host enables it, `browser_execute_javascript` appears; it runs in PageController's isolated document world and is deliberately not a page-world scripting escape hatch.

The model cap bounds snapshot content and action/diagnostic messages; truncation includes recovery guidance. Headers, readiness, and dialog evidence remain visible. Find and diagnostics do not append the page tree.

## Navigation

`browser_navigate` accepts an absolute `http:` or `https:` URL. The Browser owner applies an exact-origin site override or the default navigation policy before a new top-level destination opens.

The same policy covers direct loads, links, cross-origin redirects, the omnibox, the configured home page, and `window.open()`. An allowed popup is adopted into a controlled tab; use `browser_switch_tab` with the returned id. Back, Forward, and Reload do not ask again for existing history entries, but a remembered exact-origin block still vetoes them. See [the seam's security section](../browser-electron/README.md#security) for the persistent-profile risk.

Every page-local browser tool accepts optional `tab_id`. Omission uses the selected tab and stays exclusive; an explicit id keeps the action and trailing snapshot bound to that tab. The scheduler may overlap calls for different explicit tabs, while the seam preserves call order within each tab. `browser_open_tab`, `browser_switch_tab`, `browser_close_tab`, and `browser_screenshot` remain window-wide lifecycle barriers.

## Sensitive history and Full CDP

`browser_history_search` returns at most 20 case-insensitive title/URL matches from the app-owned Browser ledger. The Browser owner applies the separate history-access policy first: `allow` proceeds, `block` denies, and `ask` requires an `allowed-once` approval bound to the exact query and tool call. This model path is separate from the user's history manager in Settings.

`browser_cdp_command` and `browser_cdp_read_events` exist only while both the deployment ceiling and the user's Full CDP opt-in are enabled. Every call still requires a fresh approval bound to the selected controlled tab, its HTTP(S) origin, and the requested command or event read; cross-target domains are unavailable and values are bounded. Turning the effective setting off removes both schemas again.

## Separate coding/test automation

The default Browser uses Hydra's controlled Electron tabs and permissions. It produces no Playwright codegen text. Desktop rendering remains the default; viewport resize is available, while mobile emulation is not a token-saving preset.

For an independently requested browser coding/test deliverable, Microsoft's [Playwright CLI + Skills](https://github.com/microsoft/playwright-cli) is a separate workflow: `npm install -g @playwright/cli@latest`, then `playwright-cli install --skills` in the intended project. Its sessions and cookies belong to that workflow, not `ctx.browsers`. Do not use it to bypass a Hydra Browser denial.

## Model Experience

### System prompt

#### What the model sees

One section, `tool:browser`, at order 115 — after the terminal guidance and beside `web_fetch`'s. Its element-list format is PageAgent's own. Hydra owns the loop: indexed and named PageController tools are the path; `browser_page_agent_run` starts the vendored ReAct engine only when the user asks for that upstream engine.

##### Browser accessibility guidance

```markdown
The browser tools drive Hydra's embedded browser, which opens on the first call and closes with the session or browser_close. When a home page is configured and the task concerns it without an explicit URL, call browser_state first. The embedded Browser is the default for interactive website work. A Browser-settings denial is a user security decision: report it and direct the user to Settings > Browser; never bypass it with Playwright, Puppeteer, Selenium, or another runtime. Use a separate browser testing stack only for an independently requested coding/testing deliverable.

Prefer browser_find with text or regex to locate controls: it returns matching accessibility snippets, ancestor context, and observed Playwright refs without a trailing snapshot. Text matching is case-insensitive; regex accepts a pattern or /pattern/i. Narrow broad searches when output is truncated. browser_snapshot returns Playwright's distilled accessibility tree and accepts target (ref or unique CSS selector), depth, boxes, and filename. Use a scoped snapshot when only one region matters.

There are two independent ref formats. browser_state and ordinary trailing snapshots use numeric PageController indexes such as [12]<button>Save</button>, passed as index:12. browser_find and browser_snapshot use Playwright refs such as [ref=e17], passed unchanged as target:"e17". Never turn e17 into index:17. Click, hover, type, select-option, select-text, and fill accept target for an observed Playwright ref or a unique CSS selector, or index/name. name matches a label, accessible button/link name, placeholder, or id. Never guess refs; ref validity is local to the observed tab and document. If a target expires, find it again. CSS selectors must resolve uniquely.

Numeric indexes are reassigned during state capture. Use only indexes from the latest visible state for that tab, or from its unchanged/diff baseline. Normal action snapshots are compact (4k characters); full reads and navigation use the configured full budget. Filtering and ranking preserve indexes. Small changes use added/changed/removed lines; UI changes report shown, hidden, expanded, collapsed, changed, and focused content. A click can open a dialog or panel without navigating. Prioritize shown, expanded, or focused content before scanning the page; hidden entries refer to the previous snapshot. Hidden, scoped, saved, truncated, or transient snapshots cannot establish an unseen diff baseline. When snapshotMode is none, actions return a short report and verification notice; page contents are not captured, so read browser_state before using numeric indexes again. Verify effects with browser_find or browser_snapshot instead of assuming a successful click completed the task.

Results identify tabId, activeTabId, settled, and capturedAt. A readiness timeout is transient evidence, never proof a control is absent; use browser_wait once before deciding. Native JavaScript dialogs remain visible even when snapshots are omitted; answer with browser_handle_dialog. Use ordinary page controls for DOM dialogs. An action rejection appears as a failure message: adapt instead of repeating it. browser_wait_for waits for text to appear/disappear; browser_wait pauses 1–10 seconds. Do not busy-poll browser_state.

Use browser_open_tab, browser_switch_tab, and browser_close_tab with observed tab ids. A page-local tool's tab_id pins its target while other tabs are selected. Different explicitly targeted tabs may run concurrently; same-tab actions remain ordered. Adopted popups appear in Hydra's tab inventory. browser_tabs returns tab inventory only; read or find controls before acting on a newly selected page.

browser_type replaces the entire field value and does not submit. browser_fill fills several fields and re-resolves each target; checkbox/radio values are "true" or "false". Submit with browser_click or browser_press Enter. browser_select_text selects a target's contents or a range using all four CSS pixel coordinates and reports the actual selectedText. Scroll vertically/horizontally to refresh numeric indexes for offscreen content. browser_hover and browser_drag perform pointer gestures.

browser_screenshot and browser_take_screenshot capture the selected HTTP(S) viewport; switch to the intended tab first. A filename, or imageResponses:omit, saves PNG evidence and returns a path without an image block, including with text-only models. Image delivery requires a mounted attachment store and an image-capable model. Screenshots cannot target background tabs, browser chrome, a crop, or a full page. Use them when layout matters; continue acting through observed refs, names, or selectors.

browser_console_messages uses the configured consoleLevel (error by default), with a per-call level override. browser_network_requests lists retained requests with optional URL regex filter; use its observed index with browser_network_request and select the needed headers/body part. Diagnostics have bounded retention and may expire. Their results omit trailing snapshots. These diagnostic tools and browser_snapshot accept filename to save output instead of placing it in context. Filenames are plain basenames; the returned absolute path is in a private per-call output directory. Read only the needed section of a saved file. Temporary output may be cleaned by the host; copy evidence into the intended deliverable when it must persist.

browser_upload_file selects an existing readable absolute local file through an indexed HTML file input, including hidden inputs. File selection can upload immediately; submission is separate. browser_drop accepts MIME text or local files. Uploads permissions apply to file selection/drop; never substitute a different file or bypass a denial. Use an artifact created for the task when appropriate, and inspect the result before continuing.

Hydra owns the reasoning loop. browser_page_agent_run starts the vendored PageAgent engine only when explicitly requested; do not poll it for ordinary browsing. Optional experimental JavaScript runs in an isolated document world; use it only when normal browser actions cannot perform the inspection, never to bypass confirmation or domain policy. If captcha or missing login credentials block the task, report the blocker instead of guessing.
```

#### Token effect

Fixed guidance cost per request wherever the package is loaded, whether or not the model ever opens a page. The text does not vary with config; a scoped tool restriction hides the schemas but not this section.

#### KV Cache effect

Prefix-stable while the package is loaded and the section text is unchanged. Loading or unloading the plugin may invalidate reuse from the first changed prompt section.

### Tool schemas

#### What the model sees

The generated [`browser_*` schemas](../../../docs/tool-catalog.md#hydraharness-tool-browser): navigation, state, wait, indexed or named accessibility actions, `browser_find`, `browser_fill`, tab actions including `browser_forward`, selected-viewport screenshot, sensitive-history search, and demoted `browser_page_agent_run`/`status`/`stop`. PageAgent uses the invoking Hydra agent's selected model through a private host bridge; no API key or PageAgent UI is sent to a page. Screenshot appears only while durable attachments are mounted; experimental JavaScript appears only when its host gate is enabled, while the two Full CDP schemas appear only during the effective organization-and-user opt-in. `maxStateChars` and `timeoutMs` are deployment settings, not model arguments.

#### Token effect

Fixed schema cost per request for the browser, history, and PageAgent controls; experimental JavaScript adds one only when the host explicitly enables it, and effective Full CDP adds two more.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged. Plugin lifecycle or a scoped restriction may invalidate reuse from the first changed schema token.

### Browser result

#### What the model sees

`<action message>`, a blank line, then `<tab list>\n<snapshot tab>\n\n<header>\n<content>\n<footer>`. `browser_state` omits the action line, because reading a page took no action to report. A background target is labeled after the snapshot id. A cut element list appends a blank line and `(Element list truncated. Scroll to a narrower part of the page to see the rest.)`. A compact action whose normalized element list repeats the previous result for the same tab omits the list and appends `(Page content unchanged since the previous browser result. Existing element indexes remain valid.)`. A compact action snapshot also appends `(Compact snapshot after the action. Call browser_state for the full element list.)`. `settled: false` adds an explicit transient-evidence warning.

#### Token effect

Data-dependent and resent until compaction. Full state and navigate results are bounded by `maxStateChars` plus the fixed-shape header and footer. Ordinary actions use a ranked ~4k element list so a long browsing run does not append a 16k dump on every click.

#### KV Cache effect

Append-only; each result follows the reusable request prefix and does not invalidate existing entries.

### Browser failure

#### What the model sees

`Error: <message>` carrying the seam's own text — `BROWSER_UNAVAILABLE` when no `electron` is installed, `BROWSER_LAUNCH_FAILED` with the child's stderr tail, `BROWSER_GONE` after the user closed the window or the renderer died, `BROWSER_TIMEOUT`, `BROWSER_DISPOSING`, `BROWSER_DISABLED` when user settings disable agent control, and `BROWSER_POLICY_DENIED` when upload, sensitive-history, or Full CDP settings or approval deny an operation. The first five are transport and lifecycle failures; the last two are user-control failures. A page that refused an action is a result, not an error.

#### Token effect

Only the failing call adds these retained tokens. `BROWSER_LAUNCH_FAILED` is the largest of them, because it carries the child's stderr so the failure is diagnosable without a second run.

#### KV Cache effect

Append-only; the error follows the reusable request prefix and does not invalidate existing entries.

### Argument errors

#### What the model sees

Schema validation rejects a missing or wrongly-typed argument before execution. The value checks left to the tools are a blank `url`, a blank `key`, and a `url` with no origin, which become exactly `Error: url must be a non-empty string`, `Error: key must be a non-empty string`, and `Error: url must be an absolute http(s) URL: <url>`; none of them reaches the window. A call arriving with no initiating agent — impossible from a model, reachable from a direct `ctx.tools.execute` — becomes `Error: browser tools require an initiating agent`.

#### Token effect

Only the failing call adds these retained tokens.

#### KV Cache effect

Append-only; the error follows the reusable request prefix and does not invalidate existing entries.

## Known Limitations and Deferred Work

- Tool names follow Playwright MCP, with Hydra tab ids and independent numeric/Playwright refs. Host-side `browser_run_code_unsafe`, multi-file chooser uploads, and optional MCP capability groups are not implemented. `browser_evaluate` executes an isolated-world function body, not a Playwright callback.
- Native pointer input requires a visible foreground Electron window. Hidden or unfocused clicks use PageController; hidden hover and drag cannot be treated as successful native gestures. Electron supports alert/confirm; its prompt dialogs are unavailable.

- **Experimental JavaScript is host-gated.** It is absent by default, runs in the isolated document world when enabled, and cannot access page-world globals.
- **No screenshot-based control.** `browser_take_screenshot` observes the selected viewport only; it cannot target a crop or full page and accepts no visual coordinates. The accessibility snapshot remains the action modality.
- **File upload requires the real input.** It supports an indexed HTML `<input type="file">`, including hidden inputs; a proxy button without a real input is not addressable.
- **The cap ranks, then cuts.** A page over the full or compact budget loses its tail with a notice; ranking prefers new and typical form controls but is not a summary. `browser_find` or `browser_scroll` is the recovery.
- **Presenters are pure over arguments** because they re-run during session-log replay, where no browser exists. That is why a pending call shows `Click [12]` rather than the element's label: the label lives in a process the replay does not have.
