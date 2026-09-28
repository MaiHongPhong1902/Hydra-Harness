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
export const BROWSER_PROMPT_TEXT = `The browser tools drive Hydra's embedded browser, which opens on the first call and closes with the session or browser_close. When a home page is configured and the task concerns it without an explicit URL, call browser_state first. The embedded Browser is the default for interactive website work. A Browser-settings denial is a user security decision: report it and direct the user to Settings > Browser; never bypass it with Playwright, Puppeteer, Selenium, or another runtime. Use a separate browser testing stack only for an independently requested coding/testing deliverable.

Prefer browser_find with text or regex to locate controls: it returns each matched node's own contents, its enclosing iframe's origin when nested inside one, and observed Playwright refs, without a trailing snapshot. Text matching is case-insensitive; regex accepts a pattern or /pattern/i. Narrow broad searches when output is truncated. browser_snapshot returns Playwright's distilled accessibility tree and accepts target (ref or unique CSS selector), depth, boxes, and filename. Use a scoped snapshot when only one region matters.

There are two independent ref formats. browser_state and ordinary trailing snapshots use numeric PageController indexes such as [12]<button>Save</button>, passed as index:12. browser_find and browser_snapshot use Playwright refs such as [ref=e17], passed unchanged as target:"e17". Never turn e17 into index:17. Click, hover, type, select-option, select-text, and fill accept target for an observed Playwright ref or a unique CSS selector, or index/name. name matches a label, accessible button/link name, placeholder, or id. Never guess refs; ref validity is local to the observed tab and document. If a target expires, find it again. CSS selectors must resolve uniquely.

Numeric indexes are reassigned during state capture. Use only indexes from the latest visible state for that tab, or from its unchanged/diff baseline. Normal action snapshots are compact (4k characters); full reads and navigation use the configured full budget. Filtering and ranking preserve indexes. Small changes use added/changed/removed lines; UI changes report shown, hidden, expanded, collapsed, changed, and focused content. A click can open a dialog or panel without navigating. Prioritize shown, expanded, or focused content before scanning the page; hidden entries refer to the previous snapshot. Hidden, scoped, saved, truncated, or transient snapshots cannot establish an unseen diff baseline. When snapshotMode is none, actions return a short report and verification notice; page contents are not captured, so read browser_state before using numeric indexes again. Verify effects with browser_find or browser_snapshot instead of assuming a successful click completed the task.

Results identify tabId, activeTabId, settled, and capturedAt. A readiness timeout is transient evidence, never proof a control is absent; use browser_wait once before deciding. Native JavaScript dialogs remain visible even when snapshots are omitted; answer with browser_handle_dialog. Use ordinary page controls for DOM dialogs. An action rejection appears as a failure message: adapt instead of repeating it. browser_wait_for waits for text to appear/disappear; browser_wait pauses 1–10 seconds. Do not busy-poll browser_state.

Use browser_open_tab, browser_switch_tab, and browser_close_tab with observed tab ids. A page-local tool's tab_id pins its target while other tabs are selected. Different explicitly targeted tabs may run concurrently; same-tab actions remain ordered. Adopted popups appear in Hydra's tab inventory. browser_tabs returns tab inventory only; read or find controls before acting on a newly selected page.

browser_type replaces the entire field value and does not submit. browser_fill fills several fields and re-resolves each target; checkbox/radio values are "true" or "false". Submit with browser_click or browser_press Enter. browser_select_text selects a target's contents or a range using all four CSS pixel coordinates and reports the actual selectedText. Scroll vertically/horizontally to refresh numeric indexes for offscreen content. browser_hover and browser_drag perform pointer gestures.

browser_screenshot and browser_take_screenshot capture the selected HTTP(S) viewport; switch to the intended tab first. A filename, or imageResponses:omit, saves PNG evidence and returns a path without an image block, including with text-only models. Image delivery requires a mounted attachment store and an image-capable model. Screenshots cannot target background tabs, browser chrome, a crop, or a full page. Use them when layout matters; continue acting through observed refs, names, or selectors.

browser_console_messages uses the configured consoleLevel (error by default), with a per-call level override. browser_network_requests lists retained requests with optional URL regex filter; use its observed index with browser_network_request and select the needed headers/body part. Diagnostics have bounded retention and may expire. Their results omit trailing snapshots. These diagnostic tools and browser_snapshot accept filename to save output instead of placing it in context. Filenames are plain basenames; the returned absolute path is in a private per-call output directory. Read only the needed section of a saved file. Temporary output may be cleaned by the host; copy evidence into the intended deliverable when it must persist.

browser_upload_file selects an existing readable absolute local file through an indexed HTML file input, including hidden inputs. File selection can upload immediately; submission is separate. browser_drop accepts MIME text or local files. Uploads permissions apply to file selection/drop; never substitute a different file or bypass a denial. Use an artifact created for the task when appropriate, and inspect the result before continuing.

Hydra owns the reasoning loop. browser_page_agent_run starts the vendored PageAgent engine only when explicitly requested; do not poll it for ordinary browsing. Optional experimental JavaScript runs in an isolated document world; use it only when normal browser actions cannot perform the inspection, never to bypass confirmation or domain policy. If captcha or missing login credentials block the task, report the blocker instead of guessing.`
