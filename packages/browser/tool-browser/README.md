# @hydra/harness-tool-browser

The model-facing half of the embedded browser: standard `browser_*` tools over controlled tabs, a selected-viewport screenshot, policy-gated history search, opt-in Full CDP controls, demoted `browser_page_agent_*` controls for the vendored ReAct engine, and the one browser prompt section. The user also has a native tab strip and omnibox; the window, the page, and the process live behind `ctx.browsers` in [@hydra/harness-browser-electron](../browser-electron/README.md).

The split is the usual consumer/seam one. Everything the model can see — schema wording, the DOM-format guidance, the character cap, the card titles — is decided here; nothing here knows that the browser is Electron.

## What one call returns

Every DOM/action tool answers with the same object, and the model reads it as one text block: what the action did, the controlled tab list, the snapshot tab, then the page it left behind. The structured value uses `tabId` for that snapshot and its valid element indices, `activeTabId` for the tab selected in the visible chrome, plus `settled`, `capturedAt`, `truncated`, and `compact`. An exhausted readiness wait is transient evidence, not a UI verdict.

`browser_state` and `browser_navigate` return a full snapshot, still bounded by `maxStateChars` (default 16,000). Every other browser result is compact: explicitly ignored accessibility nodes are omitted, then controls are ranked, the header is shortened, a one-line tab summary is used when only one tab is open, and the element-list budget is 4,000 characters. A small same-tab change is returned as a revision diff with added, changed, and removed indexed lines. An empty diff keeps the previous indexes valid; large changes and navigation return a full snapshot. Compact results still carry valid PageController indexes; omitted lines never renumber them.

```
did navigate

Open tabs:
- [1] (active) Order — https://shop.test/order (complete)
Snapshot tab: [1]

Current Page: [Order](https://shop.test/order)
Page info: 1280x900px viewport, 1280x2400px total page size

Interactive elements from top layer of the current page inside the viewport:
[0]<input id=who/>
[1]<button id=submit>Order</button>
... 1500 pixels below - scroll to see more ...
```

There is no separate "read the page" step after an action. `PageController` assigns element indices while it builds the tree, so an action that did not end with a fresh snapshot for the same tab would leave the model holding indices that no longer address anything. `browser_state` also waits boundedly for an empty SPA or SSO transition to become usable; use `browser_wait` once for later asynchronous changes.

An action the page rejects — a missing index, a `select` that has no such option — comes back as `{success: false, message}` rendered into that same text block, not as a tool error. It is a fact the model can act on, and raising it as an error would only cost a retry.

`browser_screenshot` is the one different result. It has no arguments and exists only while durable attachments are mounted. After confirming the current model route accepts image input, it captures the selected HTTP(S) tab's visible viewport, commits the bounded PNG through `ctx.attachments`, and returns attachment metadata plus an image block. Raw base64 never enters tool or session output. Switch tabs first when another tab is intended; screenshots cannot target a background tab, Browser chrome, a crop, or a full page and supply no action coordinates.

## Config

| key | default | effect |
| --- | --- | --- |
| `maxStateChars` | `16000` | Cap on the element list one call returns, matching `tool-str-replace-editor`'s `maxOutputChars`. |
| `timeoutMs` | `60000` | Cooperative tool-call budget for one browser action. |

`experimentalScriptExecution` belongs to `@hydra/harness-browser-electron`, not this consumer. When the host enables it, `browser_execute_javascript` appears; it runs in PageController's isolated document world and is deliberately not a page-world scripting escape hatch.

Only `content` is cut. The header and footer are short, fixed-shape, and are the only way the model learns there is more page below — cutting them to fit the cap would hide exactly the thing that makes the cut recoverable.

## Navigation

`browser_navigate` accepts an absolute `http:` or `https:` URL. The Browser owner applies an exact-origin site override or the default navigation policy before a new top-level destination opens.

The same policy covers direct loads, links, cross-origin redirects, the omnibox, the configured home page, and `window.open()`. An allowed popup is adopted into a controlled tab; use `browser_switch_tab` with the returned id. Back, Forward, and Reload do not ask again for existing history entries, but a remembered exact-origin block still vetoes them. See [the seam's security section](../browser-electron/README.md#security) for the persistent-profile risk.

Every page-local DOM tool accepts optional `tab_id`. Omission uses the selected tab and stays exclusive; an explicit id keeps the action and trailing snapshot bound to that tab. The scheduler may overlap calls for different explicit tabs, while the seam preserves call order within each tab. `browser_open_tab`, `browser_switch_tab`, `browser_close_tab`, and argument-free `browser_screenshot` remain window-wide lifecycle barriers.

## Sensitive history and Full CDP

`browser_history_search` returns at most 20 case-insensitive title/URL matches from the app-owned Browser ledger. The Browser owner applies the separate history-access policy first: `allow` proceeds, `block` denies, and `ask` requires an `allowed-once` approval bound to the exact query and tool call. This model path is separate from the user's history manager in Settings.

`browser_cdp_command` and `browser_cdp_read_events` exist only while both the deployment ceiling and the user's Full CDP opt-in are enabled. Every call still requires a fresh approval bound to the selected controlled tab, its HTTP(S) origin, and the requested command or event read; cross-target domains are unavailable and values are bounded. Turning the effective setting off removes both schemas again.

## Model Experience

### System prompt

#### What the model sees

One section, `tool:browser`, at order 115 — after the terminal guidance and beside `web_fetch`'s. Its element-list format is PageAgent's own. Hydra owns the loop: indexed and named PageController tools are the path; `browser_page_agent_run` starts the vendored ReAct engine only when the user asks for that upstream engine.

##### Browser DOM guidance

```markdown
The browser tools drive one embedded browser window. It opens on your first browser call and closes when the session ends; there is nothing to open or close yourself. When the host configures a browser home page, it loads before the first result. For a direct request about that website with no explicit URL, call `browser_state` first instead of asking the user to choose a page. Normal browser results represent the page as text; when `browser_screenshot` is available, it explicitly returns one visual snapshot.

The embedded Browser is the default for interactive website work. A Browser-settings denial is a user security decision: report it and direct the user to Settings > Browser; never work around it by proposing or setting up Playwright, Puppeteer, Selenium, or another browser runtime. Create a separate browser test stack only when the user independently asks for that deliverable.

Hydra decides every browser action. PageController supplies the numbered text DOM and executes indexed or named clicks, typing, and scrolls; do not treat an in-page engine as a second agent. Prefer `browser_find`, named click/type/select, and `browser_fill` for forms and labeled controls. Use `browser_state` when you need the full element list. `browser_page_agent_run` is only for an explicit user request to run the upstream PageAgent engine; do not poll it for ordinary work.

`browser_state` and `browser_navigate` return a full snapshot. Every other browser result is compact: ignored accessibility nodes are omitted, controls are ranked, the header is shorter, and the element-list budget is 4k. If the page content is unchanged, the result says so and indexes from the previous result remain valid. Compact results still carry valid indices for changed content; call `browser_state` when a control is missing.

Every browser result lists the controlled tabs and names the snapshot tab before the same three page blocks: the current URL and scroll position; the list of interactive elements; and a footer saying whether content continues below. The structured result carries `tabId` for the snapshot and its valid indices, `activeTabId` for the tab selected in the visible chrome, plus `settled` and `capturedAt`. A result with `settled: false` is transient evidence, never proof that a feature or control is absent; call `browser_wait` once before deciding.

Elements are listed as [index]<type>text</type>:

[33]<div>User form</div>
	*[35]<button aria-label='Submit form'>Submit</button>

- Only elements with a numeric [index] can be acted on, and only indexes the most recent result for that same tab listed; when that result reported unchanged content, the indexes from the previous result for that tab are still the current ones.
- A tab of indentation means the element is a child of the element above it.
- `*[` marks an element that has appeared since the previous result for the same URL.
- Text without [] is page content, not something you can act on.
- Compact snapshots rank `*[` lines first, then typical form controls, then the rest.

Indexes are reassigned on every action. Never reuse an index from an earlier result — read the one the last call returned. Click, type, and select accept either that index or a `name` matching the control's visible label, accessible name, placeholder, or id. `browser_find` locates a query in the current snapshot and may scroll once to bring a match into view. `browser_fill` types several named or indexed fields in one call and re-resolves each field after the previous one.

Ordinary controls are listed inside the visible viewport; HTML file inputs are also listed when a site hides them. For other controls outside the viewport, use `browser_scroll` vertically or `browser_scroll_horizontally` for wide pages and tables, then act on the indexes the scroll returned. `browser_find` is the cheaper way to look for a named control before scrolling blindly.

Use `browser_open_tab`, `browser_switch_tab`, and `browser_close_tab` with ids from the latest tab list. Page-local tools accept an optional `tab_id`; provide it to keep the operation bound to that tab even while another tab is selected. Independent calls with different explicit `tab_id` values may run in parallel, but actions for one tab remain ordered because every result replaces that tab's valid element indices. A link that opens a new tab is adopted into this same controlled window; inspect the returned tab inventory instead of assuming the original tab changed.

Use `browser_screenshot` when rendered appearance or spatial layout matters and the text DOM is insufficient. It captures only the visible viewport of the selected HTTP(S) tab; switch to the intended tab first. It cannot target background tabs, browser chrome, a crop, or a full page, and it does not provide coordinates for actions — continue to act through indices or names from the latest text result.

`browser_type` replaces a field's contents rather than appending to them, so type the whole value you want. It does not submit: reach the submit control by index or name and `browser_click` it, or `browser_press` Enter while the field is focused.

`browser_upload_file` selects one existing readable local file through an indexed HTML file input, including hidden inputs. Give it an index from the latest result and an absolute path to the intended file, which may be an artifact you created for the task. The Uploads Browser permission allows, requests approval for, or blocks the transfer. Do not ask the user to type a path solely to authorize an upload. Never substitute a different file or bypass a denial. File selection may start sending bytes immediately; form submission is a separate action. Inspect the returned page state before continuing.

An action that the page rejects comes back as a failure message rather than an error; read it and adapt instead of repeating the same call. Use `browser_wait` for a bounded 1–10 second wait when data or animation changes after the returned state; do not busy-poll `browser_state`. If the optional experimental JavaScript tool is present, use it only when indexed PageController actions cannot perform the requested inspection and never use it to bypass a user-confirmation or domain policy. If a captcha or a login you have no credentials for blocks the task, say so rather than guessing.
```

#### Token effect

Fixed guidance cost per request wherever the package is loaded, whether or not the model ever opens a page. The text does not vary with config; a scoped tool restriction hides the schemas but not this section.

#### KV Cache effect

Prefix-stable while the package is loaded and the section text is unchanged. Loading or unloading the plugin may invalidate reuse from the first changed prompt section.

### Tool schemas

#### What the model sees

The generated [`browser_*` schemas](../../../docs/tool-catalog.md#hydraharness-tool-browser): navigation, state, wait, indexed or named DOM actions, `browser_find`, `browser_fill`, tab actions including `browser_forward`, selected-viewport screenshot, sensitive-history search, and demoted `browser_page_agent_run`/`status`/`stop`. PageAgent uses the invoking Hydra agent's selected model through a private host bridge; no API key or PageAgent UI is sent to a page. Screenshot appears only while durable attachments are mounted; experimental JavaScript appears only when its host gate is enabled, while the two Full CDP schemas appear only during the effective organization-and-user opt-in. `maxStateChars` and `timeoutMs` are deployment settings, not model arguments.

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

- **Experimental JavaScript is host-gated.** It is absent by default, runs in the isolated document world when enabled, and cannot access page-world globals.
- **No screenshot-based control.** `browser_screenshot` observes the selected viewport only; it cannot target a crop or full page and accepts no visual coordinates. The text DOM remains the action modality.
- **File upload requires the real input.** It supports an indexed HTML `<input type="file">`, including hidden inputs; a proxy button without a real input is not addressable.
- **The cap ranks, then cuts.** A page over the full or compact budget loses its tail with a notice; ranking prefers new and typical form controls but is not a summary. `browser_find` or `browser_scroll` is the recovery.
- **Presenters are pure over arguments** because they re-run during session-log replay, where no browser exists. That is why a pending call shows `Click [12]` rather than the element's label: the label lives in a process the replay does not have.
