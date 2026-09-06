/**
 * The one system-prompt section the browser tools contribute: how to read the
 * text DOM they return. The element-list format is page-agent's, so this text
 * is adapted from its `packages/core/src/prompts/system_prompt.md` with the
 * action names re-prefixed. Its ReAct loop, `AgentOutput` shape, and `done`
 * action are ordinarily absent because the harness owns its own loop. The
 * actual upstream PageAgent runtime is also available through the explicit
 * `browser_page_agent_*` controls when autonomous in-page execution is asked.
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

Indexes are reassigned on every action. Never reuse an index from an earlier result — read the one the last call returned. Only elements in the visible viewport are listed, so content outside it is not addressable until you reach it: use \`browser_scroll\` vertically or \`browser_scroll_horizontally\` for wide pages and tables, then act on the indexes the scroll returned.

Use \`browser_open_tab\`, \`browser_switch_tab\`, and \`browser_close_tab\` with ids from the latest tab list. Page-local tools accept an optional \`tab_id\`; provide it to keep the operation bound to that tab even while another tab is selected. Independent calls with different explicit \`tab_id\` values may run in parallel, but actions for one tab remain ordered because every result replaces that tab's valid element indices. A link that opens a new tab is adopted into this same controlled window; inspect the returned tab inventory instead of assuming the original tab changed.

Use \`browser_screenshot\` when rendered appearance or spatial layout matters and the text DOM is insufficient. It captures only the visible viewport of the selected HTTP(S) tab; switch to the intended tab first. It cannot target background tabs, browser chrome, a crop, or a full page, and it does not provide coordinates for actions — continue to act through indices from the latest text result.

\`browser_type\` replaces a field's contents rather than appending to them, so type the whole value you want. It does not submit: reach the submit control by index and \`browser_click\` it, or \`browser_press\` Enter while the field is focused.

\`browser_upload_file\` selects one existing local test artifact through an observed HTML file input. Give it an index from the latest result and an absolute path that the user wrote as a standalone or quoted literal in the current turn; never guess, discover, or substitute another host path. It does not submit the form; inspect the returned page state before taking the next action.

The real upstream PageAgent engine (Core ReAct loop and PageController) runs privately in every controlled page, but Hydra owns all controls: it adds no PageAgent panel or page-visible API key. During an indexed click, type, selection, or \`browser_page_agent_run\`, Hydra shows PageAgent's passive mask and virtual cursor; it does not create controls for the webpage user. Use \`browser_page_agent_run\` for a bounded autonomous task after reading the current page state; its model requests use this agent’s selected Hydra provider and model. Poll \`browser_page_agent_status\` and use \`browser_page_agent_stop\` before attempting a conflicting manual action. The normal \`browser_*\` tools remain the preferred evidence-first path for testcase verification.

An action that the page rejects comes back as a failure message rather than an error; read it and adapt instead of repeating the same call. Use \`browser_wait\` for a bounded 1–10 second wait when data or animation changes after the returned state; do not busy-poll \`browser_state\`. If the optional experimental JavaScript tool is present, use it only when indexed PageController actions cannot perform the requested inspection and never use it to bypass a user-confirmation or domain policy. If a captcha or a login you have no credentials for blocks the task, say so rather than guessing.`
