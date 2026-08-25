# @bosch/bh-tool-browser

The model-facing half of the embedded browser: standard `browser_*` tools over controlled tabs, explicit controls for the full upstream PageAgent runtime, and the one prompt section that teaches the model to read a text DOM. The user also has a native tab strip and omnibox; the window, the page, and the process live behind `ctx.browsers` in [@bosch/bh-browser-electron](../browser-electron/README.md).

The split is the usual consumer/seam one. Everything the model can see — schema wording, the DOM-format guidance, the character cap, the card titles — is decided here; nothing here knows that the browser is Electron.

## What one call returns

Every tool answers with the same object, and the model reads it as one text block: what the action did, the controlled tab list, the snapshot tab, then the page it left behind. The structured value uses `tabId` for that snapshot and its valid element indices, `activeTabId` for the tab selected in the visible chrome, plus `settled` and `capturedAt`; an exhausted readiness wait is transient evidence, not a UI verdict.

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

## Config

| key | default | effect |
| --- | --- | --- |
| `maxStateChars` | `16000` | Cap on the element list one call returns, matching `tool-str-replace-editor`'s `maxOutputChars`. |
| `timeoutMs` | `60000` | Cooperative tool-call budget for one browser action. |

`experimentalScriptExecution` belongs to `@bosch/bh-browser-electron`, not this consumer. When the host enables it, `browser_execute_javascript` appears; it runs in PageController's isolated document world and is deliberately not a page-world scripting escape hatch.

Only `content` is cut. The header and footer are short, fixed-shape, and are the only way the model learns there is more page below — cutting them to fit the cap would hide exactly the thing that makes the cut recoverable.

## Navigation

`browser_navigate` accepts an absolute `http:` or `https:` URL and opens it directly. It does not request origin approval.

The controlled window follows normal Chromium page navigation, including cross-origin redirects. A `window.open()` page is adopted into a controlled tab; use `browser_switch_tab` with the returned id. See [the seam's security section](../browser-electron/README.md#security) for the persistent-profile risk.

Every page-local tool accepts optional `tab_id`. Omission uses the selected tab and stays exclusive; an explicit id keeps the action and trailing snapshot bound to that tab. The scheduler may overlap calls for different explicit tabs, while the seam preserves call order within each tab. `browser_open_tab`, `browser_switch_tab`, and `browser_close_tab` remain window-wide lifecycle barriers.

## Model Experience

### System prompt

#### What the model sees

One section, `tool:browser`, at order 115 — after the terminal guidance and beside `web_fetch`'s. Its element-list format is PageAgent's own. The normal tools remain evidence-first; `browser_page_agent_run` starts PageAgent's separate upstream ReAct loop for a bounded autonomous in-page task, and `browser_page_agent_status`/`browser_page_agent_stop` control it.

##### Browser DOM guidance

```markdown
The browser tools drive one embedded browser window. It opens on your first browser call and closes when the session ends; there is nothing to open or close yourself. You perceive the page as text, never as an image.

Every browser result includes the controlled tab list, the snapshot tab, then a header with the current URL and scroll position, the list of interactive elements, and a footer saying whether content continues below. `tabId` identifies the snapshot and valid indices; `activeTabId` identifies the visibly selected tab. A result with `settled: false` is transient evidence; use `browser_wait` once before deciding that a UI control is absent.

Elements are listed as [index]<type>text</type>:

[33]<div>User form</div>
	*[35]<button aria-label='Submit form'>Submit</button>

- Only elements with a numeric [index] can be acted on, and only indexes the most recent result actually listed.
- A tab of indentation means the element is a child of the element above it.
- `*[` marks an element that has appeared since the previous result for the same URL.
- Text without [] is page content, not something you can act on.

Indexes are reassigned on every action. Never reuse an index from an earlier result for that tab — read the one the last call returned. Only elements in the visible viewport are listed, so content the footer says lies below is not addressable until you reach it: `browser_scroll` vertically or `browser_scroll_horizontally` for a wide table, then act on the indexes the scroll returned. Use `browser_open_tab`, `browser_switch_tab`, and `browser_close_tab` with ids from the latest tab list; page-local tools accept `tab_id`, and independent calls for different ids may run together.

`browser_type` replaces a field's contents rather than appending to them, so type the whole value you want. It does not submit: reach the submit control by index and `browser_click` it, or `browser_press` Enter while the field is focused.

`browser_upload_file` selects one existing local test artifact through an observed HTML file input. Give it an index from the latest result and an absolute path that the user wrote as a standalone or quoted literal in the current turn; never guess, discover, or substitute another host path. It does not submit the form; inspect the returned page state before taking the next action.

An action that the page rejects comes back as a failure message rather than an error; read it and adapt instead of repeating the same call. Use `browser_wait` for a bounded 1–10 second wait after asynchronous data changes. If the optional experimental JavaScript tool is present, use it only when indexed actions cannot inspect the requested state and never to bypass a domain or confirmation policy. If a captcha or a login you have no credentials for blocks the task, say so rather than guessing.
```

#### Token effect

Fixed guidance cost per request wherever the package is loaded, whether or not the model ever opens a page. The text does not vary with config; a scoped tool restriction hides the schemas but not this section.

#### KV Cache effect

Prefix-stable while the package is loaded and the section text is unchanged. Loading or unloading the plugin may invalidate reuse from the first changed prompt section.

### Tool schemas

#### What the model sees

The generated [`browser_*` schemas](../../../docs/tool-catalog.md#boschbh-tool-browser): navigation, state, wait, indexed DOM actions, tab actions, and `browser_page_agent_run`/`status`/`stop`. PageAgent uses the invoking BH agent's selected model through a private host bridge; no API key or PageAgent UI is sent to a page. The optional experimental JavaScript schema is present only when the host enables it. `maxStateChars` and `timeoutMs` are deployment settings, not model arguments.

#### Token effect

Fixed schema cost per request for the browser and PageAgent controls; experimental JavaScript adds one only when the host explicitly enables it.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged. Plugin lifecycle or a scoped restriction may invalidate reuse from the first changed schema token.

### Browser result

#### What the model sees

`<action message>`, a blank line, then `<tab list>\n<snapshot tab>\n\n<header>\n<content>\n<footer>`. `browser_state` omits the action line, because reading a page took no action to report. A background target is labeled after the snapshot id. A cut element list appends a blank line and `(Element list truncated. Scroll to a narrower part of the page to see the rest.)`; `settled: false` adds an explicit transient-evidence warning.

#### Token effect

Data-dependent and resent until compaction, bounded by `maxStateChars` plus the fixed-shape header and footer. A page whose DOM churns produces a fresh, differently-numbered list on every call, so a long browsing run is the most token-hungry thing this package does.

#### KV Cache effect

Append-only; each result follows the reusable request prefix and does not invalidate existing entries.

### Browser failure

#### What the model sees

`Error: <message>` carrying the seam's own text — `BROWSER_UNAVAILABLE` when no `electron` is installed, `BROWSER_LAUNCH_FAILED` with the child's stderr tail, `BROWSER_GONE` after the user closed the window or the renderer died, `BROWSER_TIMEOUT`, `BROWSER_DISPOSING`. These are transport and lifecycle failures only; a page that refused the action is a result, not an error.

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

- **No `browser_forward` tool.** The native chrome has a Forward control; model flows can use the observed tab and `browser_back` but not Forward.
- **Experimental JavaScript is host-gated.** It is absent by default, runs in the isolated document world when enabled, and cannot access page-world globals.
- **No screenshot.** The text DOM is the whole modality. `capturePage()` into `ctx.attachments.saveImage()` is a small addition, deferred until a page proves the text insufficient.
- **File upload requires the real input.** It supports an observed HTML `<input type="file">`; a proxy button or hidden chooser control is not addressable.
- **The cap cuts, it does not summarise.** A page over `maxStateChars` loses its tail with only a notice; there is no ranking of which elements matter. `browser_scroll` is the recovery, and it costs the model a round trip per screen.
- **Presenters are pure over arguments** because they re-run during session-log replay, where no browser exists. That is why a pending call shows `Click [12]` rather than the element's label: the label lives in a process the replay does not have.
