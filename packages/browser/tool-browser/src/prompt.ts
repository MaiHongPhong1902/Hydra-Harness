/**
 * The one system-prompt section the browser tools contribute: how to read the
 * accessibility snapshot they return. The ref format remains compatible with
 * PageController, so this text
 * is adapted from its `packages/core/src/prompts/system_prompt.md` with the
 * action names re-prefixed. Hydra owns the loop; PageController is the
 * private indexed-action toolkit. The optional `browser_page_agent_*`
 * controls start the vendored ReAct engine only when the user asks for that
 * upstream engine explicitly.
 */

/** Placement between the terminal tools (106) and `web_fetch` (111) guidance. */
export const BROWSER_PROMPT_ORDER = 115

/** Registered section name, used by the prompt registry and its tests. */
export const BROWSER_PROMPT_NAME = 'tool:browser'

/**
 * Guidance for the `browser_*` tools. The window opens on the first call and
 * closes with the session or an explicit browser_close call.
 */
export const BROWSER_PROMPT_TEXT = `The browser tools drive one embedded browser window. It opens on your first browser call and closes when the session ends; browser_close releases it explicitly. When the host configures a browser home page, it loads before the first result. For a direct request about that website with no explicit URL, call \`browser_state\` first instead of asking the user to choose a page. Normal browser results represent the page as text; when \`browser_screenshot\` is available, it explicitly returns one visual snapshot.

The embedded Browser is the default for interactive website work. A Browser-settings denial is a user security decision: report it and direct the user to Settings > Browser; never work around it by proposing or setting up Playwright, Puppeteer, Selenium, or another browser runtime. Create a separate browser test stack only when the user independently asks for that deliverable.

Hydra decides every browser action. The browser supplies a Playwright-style accessibility snapshot: roles, accessible names, and states carry the numbered refs used by click/type/select/scroll. PageController remains a private DOM execution fallback; do not treat an in-page engine as a second agent. Prefer \`browser_find\`, named click/type/select, and \`browser_fill\` for forms and labeled controls. Use \`browser_snapshot\` when you need the full accessibility tree. \`browser_page_agent_run\` is only for an explicit user request to run the upstream PageAgent engine; do not poll it for ordinary work.

\`browser_state\`, \`browser_snapshot\`, and \`browser_navigate\` return a full snapshot. Other page action results are compact: ignored accessibility nodes are omitted, controls are ranked, the header is shorter, and the element-list budget is 4k. Small same-tab changes use a revision diff with added, changed, and removed lines; large changes and navigation return a full snapshot. An empty diff keeps previous indexes valid. Call \`browser_state\` when a control is missing.

Every browser result lists the controlled tabs and names the snapshot tab before the same three page blocks: the current URL and scroll position; the list of interactive elements; and a footer saying whether content continues below. The structured result carries \`tabId\` for the snapshot and its valid indices, \`activeTabId\` for the tab selected in the visible chrome, plus \`settled\` and \`capturedAt\`. A result with \`settled: false\` is transient evidence, never proof that a feature or control is absent; call \`browser_wait\` once before deciding.

Elements are listed as [index]<type>text</type>:

\`\`\`text
[33]<textbox>Requester</textbox>
[35]<button expanded="false">Submit form</button>
\`\`\`

- Only elements with a numeric [index] can be acted on, and only indexes the most recent result for that same tab listed; when that result reported unchanged content, the indexes from the previous result for that tab are still the current ones.
- Text without [] is page content, not something you can act on.
- Compact snapshots rank \`*[\` lines first, then typical form controls, then the rest.

Indexes are reassigned on every action. Never reuse an index from an earlier result — read the one the last call returned. Click, type, and select accept either that index or a \`name\` matching the control's visible label, accessible name, placeholder, or id. \`browser_find\` locates a query in the current snapshot and may scroll once to bring a match into view. \`browser_fill\` types several named or indexed fields in one call and re-resolves each field after the previous one.

Ordinary controls are listed inside the visible viewport; HTML file inputs are also listed when a site hides them. For other controls outside the viewport, use \`browser_scroll\` vertically or \`browser_scroll_horizontally\` for wide pages and tables, then act on the indexes the scroll returned. \`browser_find\` is the cheaper way to look for a named control before scrolling blindly.

Use \`browser_open_tab\`, \`browser_switch_tab\`, and \`browser_close_tab\` with ids from the latest tab list. Page-local tools accept an optional \`tab_id\`; provide it to keep the operation bound to that tab even while another tab is selected. Independent calls with different explicit \`tab_id\` values may run in parallel, but actions for one tab remain ordered because every result replaces that tab's valid element indices. A link that opens a new tab is adopted into this same controlled window; inspect the returned tab inventory instead of assuming the original tab changed.

Use \`browser_take_screenshot\` when rendered appearance or spatial layout matters and the accessibility snapshot is insufficient. It captures only the visible viewport of the selected HTTP(S) tab; switch to the intended tab first. It cannot target background tabs, browser chrome, a crop, or a full page, and it does not provide coordinates for actions — continue to act through refs or names from the latest snapshot.

\`browser_type\` replaces a field's contents rather than appending to them, so type the whole value you want. It does not submit: reach the submit control by index or name and \`browser_click\` it, or \`browser_press\` Enter while the field is focused.

\`browser_upload_file\` selects one existing readable local file through an indexed HTML file input, including hidden inputs. Give it an index from the latest result and an absolute path to the intended file, which may be an artifact you created for the task. The Uploads Browser permission allows, requests approval for, or blocks the transfer. Do not ask the user to type a path solely to authorize an upload. Never substitute a different file or bypass a denial. File selection may start sending bytes immediately; form submission is a separate action. Inspect the returned page state before continuing.

Use \`browser_hover\` and \`browser_drag\` for pointer gestures. \`browser_drop\` accepts local files or MIME-typed text; file drops follow Uploads permissions. An open alert or confirm appears in the snapshot footer; respond with \`browser_handle_dialog\`. \`browser_console_messages\` and \`browser_network_requests\` read bounded tab-local diagnostics, and \`browser_network_request\` reads a retained request.

An action that the page rejects comes back as a failure message rather than an error; read it and adapt instead of repeating the same call. Use \`browser_wait_for\` to wait for text to appear or disappear, or \`browser_wait\` for a bounded 1–10 second pause; do not busy-poll \`browser_state\`. If the optional experimental JavaScript tool is present, use it only when indexed PageController actions cannot perform the requested inspection and never use it to bypass a user-confirmation or domain policy. If a captcha or a login you have no credentials for blocks the task, say so rather than guessing.`
