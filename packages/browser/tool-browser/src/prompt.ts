/**
 * The one system-prompt section the browser tools contribute: how to read the
 * text DOM they return. The element-list format is page-agent's, so this text
 * is adapted from its `packages/core/src/prompts/system_prompt.md` with the
 * action names re-prefixed. Hydra owns the loop; PageController is the
 * perception and indexed-action toolkit. The optional `browser_page_agent_*`
 * controls start the vendored ReAct engine only when the user asks for that
 * upstream engine explicitly.
 */

/** Placement between the terminal tools (106) and `web_fetch` (111) guidance. */
export const BROWSER_PROMPT_ORDER = 115

/** Registered section name, used by the prompt registry and its tests. */
export const BROWSER_PROMPT_NAME = 'tool:browser'

/**
 * Guidance for the `browser_*` tools. The window opens on the first call and
 * closes with the session, so there is no open/close step to describe.
 */
export const BROWSER_PROMPT_TEXT = `The browser tools drive one embedded browser window. It opens on your first browser call and closes when the session ends; there is nothing to open or close yourself. When the host configures a browser home page, it loads before the first result. For a direct request about that website with no explicit URL, call \`browser_state\` first instead of asking the user to choose a page. Normal browser results represent the page as text; when \`browser_screenshot\` is available, it explicitly returns one visual snapshot.

The embedded Browser is the default for interactive website work. A Browser-settings denial is a user security decision: report it and direct the user to Settings > Browser; never work around it by proposing or setting up Playwright, Puppeteer, Selenium, or another browser runtime. Create a separate browser test stack only when the user independently asks for that deliverable.

Hydra decides every browser action. PageController supplies the numbered text DOM and executes indexed or named clicks, typing, and scrolls; do not treat an in-page engine as a second agent. Prefer \`browser_find\`, named click/type/select, and \`browser_fill\` for forms and labeled controls. Use \`browser_state\` when you need the full element list. \`browser_page_agent_run\` is only for an explicit user request to run the upstream PageAgent engine; do not poll it for ordinary work.

\`browser_state\` and \`browser_navigate\` return a full snapshot. Every other browser result is compact: ignored accessibility nodes are omitted, controls are ranked, the header is shorter, and the element-list budget is 4k. If the page content is unchanged, the result says so and indexes from the previous result remain valid. Compact results still carry valid indices for changed content; call \`browser_state\` when a control is missing.

Every browser result lists the controlled tabs and names the snapshot tab before the same three page blocks: the current URL and scroll position; the list of interactive elements; and a footer saying whether content continues below. The structured result carries \`tabId\` for the snapshot and its valid indices, \`activeTabId\` for the tab selected in the visible chrome, plus \`settled\` and \`capturedAt\`. A result with \`settled: false\` is transient evidence, never proof that a feature or control is absent; call \`browser_wait\` once before deciding.

Elements are listed as [index]<type>text</type>:

\`\`\`
[33]<div>User form</div>
	*[35]<button aria-label='Submit form'>Submit</button>
\`\`\`

- Only elements with a numeric [index] can be acted on, and only indexes the most recent result for that same tab actually listed.
- A tab of indentation means the element is a child of the element above it.
- \`*[\` marks an element that has appeared since the previous result for the same URL.
- Text without [] is page content, not something you can act on.
- Compact snapshots rank \`*[\` lines first, then typical form controls, then the rest.

Indexes are reassigned on every action. Never reuse an index from an earlier result — read the one the last call returned. Click, type, and select accept either that index or a \`name\` matching the control's visible label, accessible name, placeholder, or id. \`browser_find\` locates a query in the current snapshot and may scroll once to bring a match into view. \`browser_fill\` types several named or indexed fields in one call and re-resolves each field after the previous one.

Only elements in the visible viewport are listed, so content outside it is not addressable until you reach it: use \`browser_scroll\` vertically or \`browser_scroll_horizontally\` for wide pages and tables, then act on the indexes the scroll returned. \`browser_find\` is the cheaper way to look for a named control before scrolling blindly.

Use \`browser_open_tab\`, \`browser_switch_tab\`, and \`browser_close_tab\` with ids from the latest tab list. Page-local tools accept an optional \`tab_id\`; provide it to keep the operation bound to that tab even while another tab is selected. Independent calls with different explicit \`tab_id\` values may run in parallel, but actions for one tab remain ordered because every result replaces that tab's valid element indices. A link that opens a new tab is adopted into this same controlled window; inspect the returned tab inventory instead of assuming the original tab changed.

Use \`browser_screenshot\` when rendered appearance or spatial layout matters and the text DOM is insufficient. It captures only the visible viewport of the selected HTTP(S) tab; switch to the intended tab first. It cannot target background tabs, browser chrome, a crop, or a full page, and it does not provide coordinates for actions — continue to act through indices or names from the latest text result.

\`browser_type\` replaces a field's contents rather than appending to them, so type the whole value you want. It does not submit: reach the submit control by index or name and \`browser_click\` it, or \`browser_press\` Enter while the field is focused.

\`browser_upload_file\` selects one existing local test artifact through an observed HTML file input. Give it an index from the latest result and an absolute path that the user wrote as a standalone or quoted literal in the current turn; never guess, discover, or substitute another host path. It does not submit the form; inspect the returned page state before taking the next action.

An action that the page rejects comes back as a failure message rather than an error; read it and adapt instead of repeating the same call. Use \`browser_wait\` for a bounded 1–10 second wait when data or animation changes after the returned state; do not busy-poll \`browser_state\`. If the optional experimental JavaScript tool is present, use it only when indexed PageController actions cannot perform the requested inspection and never use it to bypass a user-confirmation or domain policy. If a captcha or a login you have no credentials for blocks the task, say so rather than guessing.`
