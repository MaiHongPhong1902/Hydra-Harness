// Source of `preload.cjs` — do not load this file directly; Electron loads the
// bundle. Rebuild with `pnpm --filter @hydra/harness-browser-electron run build:preload`.
//
// This is the Electron counterpart of PageAgent's content script. It runs
// PageController in the isolated world of every document the controlled view
// loads, and constructs PageAgentCore only for an explicit page_agent_run.
// Hydra owns all user-visible controls; the upstream Panel is deliberately not
// instantiated. PageController's simulator mask and index highlights are visual
// feedback only. LLM fetches for the optional PageAgent engine cross the private
// IPC boundary and are routed by Hydra to the model the owning agent already
// selected; no provider credential reaches the webpage.
//
// The simulator mask is the sole visible DOM addition. `contextBridge` is never
// called and `ipcRenderer` never leaves this module scope, so a hostile document
// has no handle on the channel.
//
// The controller is per-document by construction: a navigation runs this script
// again against a fresh DOM. That is exactly why every element index the main
// process holds becomes invalid after a navigation.
import { ipcRenderer } from 'electron'

import { PageAgentCore } from '@page-agent/core'
import { PageController } from '@page-agent/page-controller'
import maskCss from '../third-party/page-agent/packages/page-controller/src/mask/SimulatorMask.module.css?inline'
import cursorCss from '../third-party/page-agent/packages/page-controller/src/mask/cursor.module.css?inline'
const cursorImage = 'data:image/png;base64,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'

const annotationCss = `
#hydra-browser-annotation-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  cursor: crosshair;
  background: transparent;
}
#hydra-browser-annotation-overlay[data-peeking="true"] { pointer-events: none; }
#hydra-browser-annotation-highlight {
  position: fixed;
  z-index: 2147483646;
  box-sizing: border-box;
  pointer-events: none;
  border: 2px solid #0096e8;
  border-radius: 4px;
  background: rgb(0 150 232 / 12%);
}
#hydra-browser-annotation-tip {
  position: fixed;
  z-index: 2147483647;
  top: 12px;
  left: 50%;
  translate: -50% 0;
  pointer-events: none;
  padding: 7px 10px;
  border-radius: 7px;
  color: #fff;
  background: #17191c;
  font: 12px/1.25 system-ui, sans-serif;
  box-shadow: 0 4px 16px rgb(0 0 0 / 35%);
}
`

const HARNESS_OVERLAY_SELECTOR = [
  '#playwright-highlight-container',
  '#page-agent-runtime_simulator-mask',
  '#hydra-browser-annotation-overlay',
  '#hydra-browser-annotation-highlight',
  '#hydra-browser-annotation-tip',
].join(', ')

const cursorOverrideCss = `
#page-agent-runtime_simulator-mask { cursor: default; }
#page-agent-runtime_simulator-mask [class*="cursor_"] {
  width: 1px;
  height: 1px;
}
#page-agent-runtime_simulator-mask [class*="cursorFilling"] {
  width: 32px;
  height: 32px;
  margin: 0;
  transform: translate(-29px, -15px);
  background: url(${cursorImage}) center / contain no-repeat;
}
#page-agent-runtime_simulator-mask [class*="cursorBorder"] { display: none; }
#page-agent-runtime_simulator-mask [class*="cursorRipple"] {
  width: 64px;
  height: 64px;
  margin: -32px;
}
#playwright-highlight-container,
#playwright-highlight-container * {
  pointer-events: none !important;
}
`

let cancelActiveAnnotation

/** A constructed stylesheet works when the page's CSP blocks inline style tags. */
function installMaskStyles() {
  const stylesheet = new CSSStyleSheet()
  stylesheet.replaceSync(`${maskCss}\n${cursorCss}\n${cursorOverrideCss}\n${annotationCss}`)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet]
}

/** Normalize page-owned strings before they leave the isolated preload. */
function clippedText(value, max) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Current page address without credentials, query tokens, or fragments. */
function annotationUrl() {
  try {
    const url = new URL(location.href)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return clippedText(url.href, 2_048)
  } catch {
    return clippedText(location.href, 2_048)
  }
}

/** Build a bounded, non-executable preview of one selected page element. */
async function describeElement(controller, selected) {
  await controller.updateTree()
  let element = selected
  let index
  for (let candidate = selected; candidate instanceof Element; candidate = candidate.parentElement) {
    const entry = [...controller.selectorMap].find(([, node]) => node.ref === candidate)
    if (entry !== undefined) {
      index = entry[0]
      element = candidate
      break
    }
  }
  const tag = clippedText(element.localName, 40) || 'element'
  const attributes = ['id', 'class', 'role', 'aria-label', 'title', 'alt', 'placeholder', 'type', 'name', 'data-testid']
    .map(name => [name, clippedText(element.getAttribute(name), 120)])
    .filter(([, value]) => value)
    .slice(0, 6)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('')
  const text = clippedText(element instanceof HTMLElement ? element.innerText : element.textContent, 240)
  const bounds = element.getBoundingClientRect()
  const x = Math.max(0, Math.floor(bounds.left))
  const y = Math.max(0, Math.floor(bounds.top))
  const width = Math.max(0, Math.ceil(Math.min(innerWidth, bounds.right) - x))
  const height = Math.max(0, Math.ceil(Math.min(innerHeight, bounds.bottom) - y))
  return {
    kind: 'browser-element',
    url: annotationUrl(),
    title: clippedText(document.title, 160),
    ...(index === undefined ? {} : { index }),
    ...(width === 0 || height === 0 ? {} : { rect: { x, y, width, height } }),
    preview: clippedText(text
      ? `<${tag}${attributes}>${escapeHtml(text)}</${tag}>`
      : `<${tag}${attributes} />`, 1_024),
  }
}

/** True when the node is Hydra chrome, PageController highlights, or the simulator mask. */
function isHarnessOverlay(element) {
  if (!(element instanceof Element)) return false
  return element.closest(HARNESS_OVERLAY_SELECTOR) !== null
    || element.dataset.pageAgentIgnore === 'true'
    || element.dataset.browserUseIgnore === 'true'
}

/**
 * Topmost page-owned element at a viewport point, skipping Hydra overlays.
 * @param {number} x - viewport X.
 * @param {number} y - viewport Y.
 * @returns {Element | undefined}
 */
function pageElementFromPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  for (const hit of document.elementsFromPoint(x, y)) {
    if (hit instanceof Element && !isHarnessOverlay(hit)) return hit
  }
}

/** Read the page element under a picker point without selecting our overlay. */
function elementAt(overlay, x, y) {
  overlay?.setAttribute('data-peeking', 'true')
  try {
    return pageElementFromPoint(x, y)
  } finally {
    overlay?.removeAttribute('data-peeking')
  }
}

/** Enter a one-shot element-or-region picker; Escape and page changes cancel it. */
function pickElement(controller) {
  cancelActiveAnnotation?.()
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    const highlight = document.createElement('div')
    const tip = document.createElement('div')
    overlay.id = 'hydra-browser-annotation-overlay'
    highlight.id = 'hydra-browser-annotation-highlight'
    tip.id = 'hydra-browser-annotation-tip'
    tip.textContent = 'Click an element or drag an area · Esc to cancel'
    for (const node of [overlay, highlight, tip]) node.dataset.pageAgentIgnore = 'true'

    let current
    let dragStart
    const pointTo = (x, y) => {
      current = elementAt(overlay, x, y)
      if (current === undefined) {
        highlight.hidden = true
        return
      }
      const rect = current.getBoundingClientRect()
      highlight.hidden = rect.width <= 0 || rect.height <= 0
      highlight.style.left = `${rect.left}px`
      highlight.style.top = `${rect.top}px`
      highlight.style.width = `${rect.width}px`
      highlight.style.height = `${rect.height}px`
    }
    const regionTo = (x, y) => {
      const endX = Math.max(0, Math.min(innerWidth, x))
      const endY = Math.max(0, Math.min(innerHeight, y))
      const left = Math.floor(Math.min(dragStart.x, endX))
      const top = Math.floor(Math.min(dragStart.y, endY))
      const right = Math.ceil(Math.max(dragStart.x, endX))
      const bottom = Math.ceil(Math.max(dragStart.y, endY))
      const rect = { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
      highlight.hidden = false
      highlight.style.left = `${rect.x}px`
      highlight.style.top = `${rect.y}px`
      highlight.style.width = `${rect.width}px`
      highlight.style.height = `${rect.height}px`
      return rect
    }
    const finish = (result) => {
      if (cancelActiveAnnotation !== finish) return
      cancelActiveAnnotation = undefined
      window.removeEventListener('keydown', onKeyDown, true)
      overlay.remove()
      highlight.remove()
      tip.remove()
      resolve(result)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(undefined)
    }
    cancelActiveAnnotation = finish
    overlay.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      dragStart = {
        x: Math.max(0, Math.min(innerWidth, event.clientX)),
        y: Math.max(0, Math.min(innerHeight, event.clientY)),
        pointerId: event.pointerId,
      }
      try {
        overlay.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic picker events need no pointer capture.
      }
      regionTo(event.clientX, event.clientY)
    })
    overlay.addEventListener('pointermove', (event) => {
      if (dragStart === undefined) pointTo(event.clientX, event.clientY)
      else regionTo(event.clientX, event.clientY)
    })
    overlay.addEventListener('pointerup', (event) => {
      if (dragStart === undefined || event.pointerId !== dragStart.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      const start = dragStart
      const rect = regionTo(event.clientX, event.clientY)
      dragStart = undefined
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4) {
        finish({
          kind: 'browser-region',
          url: annotationUrl(),
          title: clippedText(document.title, 160),
          rect,
          preview: `Selected viewport region (${rect.x}, ${rect.y}) ${rect.width}×${rect.height}.`,
        })
        return
      }
      const selected = elementAt(overlay, event.clientX, event.clientY)
      if (selected === undefined) finish(undefined)
      else void describeElement(controller, selected).then(finish, () => { finish(undefined) })
    })
    overlay.addEventListener('pointercancel', (event) => {
      if (dragStart !== undefined && event.pointerId === dragStart.pointerId) finish(undefined)
    })
    overlay.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      pointTo(event.clientX, event.clientY)
      const selected = current
      if (selected === undefined) finish(undefined)
      else void describeElement(controller, selected).then(finish, () => { finish(undefined) })
    })
    window.addEventListener('keydown', onKeyDown, true)
    document.documentElement.append(overlay, highlight, tip)
  })
}

/** Bridge PageAgent's OpenAI-shaped request to Hydra without exposing an API key. */
async function hydraModelFetch(_input, init = {}) {
  const raw = init.body
  const body = typeof raw === 'string' ? JSON.parse(raw) : raw
  const response = await ipcRenderer.invoke('page-agent:llm', body)
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Return a viewport point for the host-owned, secure file-upload protocol. */
function getElementCenter(controller, index) {
  const element = controller.selectorMap.get(index)?.ref
  if (!(element instanceof Element)) throw new Error(`No indexed element exists at [${index}].`)
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`Indexed element [${index}] has no usable viewport position.`)
  return { x: Math.round(rect.left + (rect.width / 2)), y: Math.round(rect.top + (rect.height / 2)) }
}

const FILE_INPUT_MARK = 'data-hydra-host-file-input'

/**
 * Tag the indexed file input so the host can address it through CDP without
 * hit-testing PageController highlights or the simulator mask.
 * @param {import('@page-agent/page-controller').PageController} controller
 * @param {number} index
 * @returns {{ token: string }}
 */
function markFileInput(controller, index) {
  const element = controller.selectorMap.get(index)?.ref
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    throw new Error('the indexed element is not an HTML file input')
  }
  const token = crypto.randomUUID()
  element.setAttribute(FILE_INPUT_MARK, token)
  return { token }
}

function unmarkFileInput(token) {
  if (typeof token !== 'string' || token.length === 0) return { success: true }
  document.querySelector(`[${FILE_INPUT_MARK}="${CSS.escape(token)}"]`)?.removeAttribute(FILE_INPUT_MARK)
  return { success: true }
}

/** Session-history flags from the document. Isolated-world clicks update this, not always Electron's list. */
function historyState() {
  const navigation = window.navigation
  if (navigation !== undefined) {
    return { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward }
  }
  return { canGoBack: window.history.length > 1, canGoForward: false }
}

function historyGo(delta) {
  const state = historyState()
  if (delta < 0 && !state.canGoBack) {
    return { success: false, message: 'No earlier page in this view.' }
  }
  if (delta > 0 && !state.canGoForward && window.navigation !== undefined) {
    return { success: false, message: 'No later page in this view.' }
  }
  window.history.go(delta)
  return { success: true }
}

/** Show the passive visual feedback around a Hydra-owned indexed DOM action. */
async function withVisualMask(controller, action) {
  await controller.showMask()
  try {
    return await action()
  } finally {
    await controller.hideMask()
  }
}

function currentHttpOrigin() {
  return location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : undefined
}

function autocompleteTokens(control) {
  return (control.getAttribute('autocomplete') ?? '').toLowerCase().trim().split(/\s+/u).filter(Boolean)
}

function formScope(x, y) {
  const target = elementAt(undefined, Number(x), Number(y))
  return target?.closest('form') ?? document
}

function usableControl(control) {
  if (!control.isConnected || control.disabled) return false
  if (control instanceof HTMLInputElement) {
    return !control.readOnly && !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(control.type)
  }
  return control instanceof HTMLSelectElement || (control instanceof HTMLTextAreaElement && !control.readOnly)
}

/** Set a native form value and emit only the browser events expected by page frameworks. */
function setAutofillValue(control, value) {
  if (!usableControl(control) || typeof value !== 'string') return false
  let next = value
  if (control instanceof HTMLSelectElement) {
    const option = [...control.options].find(candidate => candidate.value.toLowerCase() === value.toLowerCase())
    if (option === undefined) return false
    next = option.value
  }
  const prototype = control instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) return false
  setter.call(control, next)
  control.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  control.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  return true
}

function fillLogin(args) {
  if (typeof args.expectedOrigin !== 'string' || args.expectedOrigin !== currentHttpOrigin()
    || typeof args.username !== 'string' || typeof args.password !== 'string') {
    throw new Error('autofill login target is invalid')
  }
  const scope = formScope(args.x, args.y)
  const inputs = [...scope.querySelectorAll('input')].filter(usableControl)
  const password = inputs.find(input => autocompleteTokens(input).includes('current-password'))
    ?? inputs.find(input => input.type === 'password' && !autocompleteTokens(input).includes('new-password'))
  const username = inputs.find(input => autocompleteTokens(input).includes('username'))
    ?? inputs.find(input => input.type === 'email')
    ?? inputs.find(input => ['text', 'search', 'url'].includes(input.type) && input !== password)
  const usernameFilled = username === undefined ? false : setAutofillValue(username, args.username)
  const passwordFilled = password === undefined ? false : setAutofillValue(password, args.password)
  return { success: usernameFilled || passwordFilled }
}

const CONTACT_FIELDS = new Map([
  ['name', 'name'],
  ['given-name', 'givenName'],
  ['additional-name', 'additionalName'],
  ['family-name', 'familyName'],
  ['organization', 'organization'],
  ['email', 'email'],
  ['tel', 'tel'],
  ['address-line1', 'addressLine1'],
  ['address-line2', 'addressLine2'],
  ['address-level2', 'city'],
  ['address-level1', 'region'],
  ['postal-code', 'postalCode'],
  ['country', 'countryCode'],
])

function contactValue(fields, token) {
  if (token === 'street-address') {
    const lines = [fields.addressLine1, fields.addressLine2].filter(value => typeof value === 'string')
    return lines.length === 0 ? undefined : lines.join('\n')
  }
  const field = CONTACT_FIELDS.get(token)
  return field === undefined ? undefined : fields[field]
}

function fillContact(args) {
  if (typeof args.expectedOrigin !== 'string' || args.expectedOrigin !== currentHttpOrigin()
    || typeof args.fields !== 'object' || args.fields === null || Array.isArray(args.fields)) {
    throw new Error('autofill contact target is invalid')
  }
  const scope = formScope(args.x, args.y)
  let filled = false
  for (const control of scope.querySelectorAll('input[autocomplete], select[autocomplete], textarea[autocomplete]')) {
    if (!usableControl(control)) continue
    const token = autocompleteTokens(control).findLast(candidate => CONTACT_FIELDS.has(candidate) || candidate === 'street-address')
    const value = token === undefined ? undefined : contactValue(args.fields, token)
    if (typeof value === 'string') filled = setAutofillValue(control, value) || filled
  }
  return { success: filled }
}

/** Remove a serialized password value without mutating the page-owned DOM. */
function maskPasswordValues(controller, content) {
  let masked = content
  for (const node of controller.selectorMap.values()) {
    const input = node.ref
    if (!(input instanceof HTMLInputElement) || input.type !== 'password') continue
    const value = input.getAttribute('value')
    if (value === null) continue
    const serialized = value.length > 20 ? `${value.slice(0, 20)}...` : value
    masked = masked.replaceAll(`value=${serialized}`, 'value=[redacted]')
  }
  return masked
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea'])
const INDEXED_LINE = /^(\t*)(\*)?\[(\d+)\]<([a-z0-9-]+)/iu

/** Rank snapshot lines so new and typical form controls survive a later cap. */
function rankElementList(content) {
  if (typeof content !== 'string' || content.length === 0) return content
  return content.split('\n')
    .map((line, order) => ({ line, order, rank: lineRank(line) }))
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map(entry => entry.line)
    .join('\n')
}

function lineRank(line) {
  const match = INDEXED_LINE.exec(line)
  if (match === null) return 3
  if (match[2] === '*') return 0
  const tag = match[4]
  if (tag !== undefined && INTERACTIVE_TAGS.has(tag.toLowerCase())) return 1
  return 2
}

const FILLABLE_KIND = 2
const CLICKABLE_KIND = 1

function indexOfElement(controller, element) {
  for (const [index, node] of controller.selectorMap) {
    if (node.ref === element) return index
  }
}

/** Follow a labeled control so "Size" addresses the select, not the label. */
function effectiveIndex(controller, index) {
  const element = controller.selectorMap.get(index)?.ref
  if (element instanceof HTMLLabelElement && element.control instanceof Element) {
    const controlIndex = indexOfElement(controller, element.control)
    if (controlIndex !== undefined) return controlIndex
  }
  return index
}

function identityMatch(element, needle) {
  if (!(element instanceof Element)) return false
  return element.id.toLowerCase() === needle
    || (element.getAttribute('name') ?? '').toLowerCase() === needle
}

function controlKind(element) {
  if (
    element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
  ) return FILLABLE_KIND
  if (element instanceof HTMLButtonElement || element?.localName === 'button' || element?.localName === 'a') {
    return CLICKABLE_KIND
  }
  return 0
}

function elementHaystacks(controller, index, line) {
  const haystacks = [line]
  const node = controller.selectorMap.get(index)
  const element = node?.ref
  if (element instanceof Element) {
    haystacks.push(
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('name'),
      element.id,
      element.getAttribute('title'),
      element instanceof HTMLElement ? element.innerText : element.textContent,
    )
    if (
      (element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element instanceof HTMLSelectElement)
      && element.labels?.[0]?.textContent
    ) {
      haystacks.push(element.labels[0].textContent)
    }
  }
  return haystacks
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.replace(/\s+/gu, ' ').trim().toLowerCase())
}

function matchQuery(controller, query) {
  const needle = String(query).trim().toLowerCase()
  if (needle.length === 0) return []
  const matches = []
  const seen = new Set()
  const consider = (index, line) => {
    const target = effectiveIndex(controller, index)
    if (seen.has(target)) return
    const element = controller.selectorMap.get(target)?.ref
    const haystacks = [
      ...elementHaystacks(controller, index, line),
      ...(target === index ? [] : elementHaystacks(controller, target, '')),
    ]
    const exact = haystacks.some(text => text === needle)
    const partial = haystacks.some(text => text.includes(needle))
    if (!exact && !partial) return
    seen.add(target)
    matches.push({
      index: target,
      line,
      exact,
      identity: identityMatch(element, needle),
      kind: controlKind(element),
    })
  }
  for (const line of String(controller.simplifiedHTML ?? '').split('\n')) {
    const match = /\[(\d+)\]/u.exec(line)
    if (match !== null) consider(Number(match[1]), line.trim())
  }
  for (const [index, line] of controller.elementTextMap) consider(index, line)
  matches.sort((left, right) =>
    Number(right.identity) - Number(left.identity)
    || Number(right.exact) - Number(left.exact)
    || right.kind - left.kind
    || left.index - right.index)
  return matches
}

/**
 * Fail when another page element covers the indexed target's center.
 * Hydra owns this check so PageController stays unforked.
 * @param {import('@page-agent/page-controller').PageController} controller
 * @param {number} index
 * @returns {{ success: false, message: string } | undefined}
 */
function coveredClickFailure(controller, index) {
  const element = controller.selectorMap.get(index)?.ref
  if (!(element instanceof Element)) return undefined
  const rect = element.getBoundingClientRect()
  const x = rect.left + (rect.width / 2)
  const y = rect.top + (rect.height / 2)
  const hit = pageElementFromPoint(x, y)
  if (hit !== undefined && hit !== element && !element.contains(hit)) {
    return {
      success: false,
      message: `Element is covered by <${hit.localName}> at (${Math.round(x)}, ${Math.round(y)}).`,
    }
  }
}

async function resolveNamedIndex(controller, args) {
  if (typeof args.index === 'number') return args.index
  const name = String(args.name ?? '').trim()
  if (name.length === 0) throw new Error('provide index or a non-empty name')
  await controller.updateTree()
  const matches = matchQuery(controller, name)
  return matches[0]?.index
}

async function actOnNamed(controller, args, act) {
  const index = await resolveNamedIndex(controller, args)
  if (index === undefined) {
    return { success: false, message: `No element named "${String(args.name).trim()}" in the current snapshot.` }
  }
  return await withVisualMask(controller, () => act(index))
}

async function findElement(controller, query) {
  const needle = String(query ?? '').trim()
  if (needle.length === 0) throw new Error('find query must be a non-empty string')
  const search = async () => {
    await controller.updateTree()
    return matchQuery(controller, needle)
  }
  let matches = await search()
  for (let attempt = 0; attempt < 3 && matches.length === 0; attempt++) {
    await controller.scroll({ down: true, numPages: 1 })
    matches = await search()
  }
  if (matches.length === 0) {
    return { success: false, message: `No element matching "${needle}" in the current page.` }
  }
  const listing = matches.slice(0, 8).map(match => `[${match.index}]`).join(', ')
  return {
    success: true,
    message: matches.length === 1
      ? `Found 1 element matching "${needle}": [${matches[0].index}].`
      : `Found ${matches.length} elements matching "${needle}": ${listing}.`,
  }
}

async function fillFields(controller, fields) {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error('fields must be a non-empty array')
  const messages = []
  for (const field of fields) {
    await controller.updateTree()
    const index = await resolveNamedIndex(controller, field)
    if (index === undefined) {
      messages.push(`No element named "${String(field.name).trim()}" in the current snapshot.`)
      return { success: false, message: messages.join('\n') }
    }
    const element = controller.selectorMap.get(index)?.ref
    const result = element instanceof HTMLSelectElement
      ? await controller.selectOption(index, field.text)
      : await controller.inputText(index, field.text)
    messages.push(result.message)
    if (!result.success) return { success: false, message: messages.join('\n') }
  }
  return { success: true, message: messages.join('\n') }
}

// Electron evaluates a preload before navigation creates <body>. Wait for a
// document before constructing PageController. PageAgentCore is created only
// when an explicit page_agent_run arrives; Hydra owns the ordinary loop.
const pageControllerReady = new Promise((resolve, reject) => {
  const initialize = async () => {
    try {
      installMaskStyles()
      const pageController = new PageController({
        enableMask: true,
        persistentMask: true,
        highlightOpacity: 0.12,
        highlightLabelOpacity: 0.85,
      })
      await pageController.showMask()
      const getBrowserState = pageController.getBrowserState.bind(pageController)
      pageController.getBrowserState = async () => {
        const state = await getBrowserState()
        return {
          ...state,
          content: rankElementList(maskPasswordValues(pageController, state.content)),
        }
      }
      resolve(pageController)
    } catch (error) {
      reject(error)
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true })
  else initialize()
})

let pageAgent

function ensurePageAgent(controller) {
  if (pageAgent !== undefined) return pageAgent
  // `model` and `baseURL` satisfy PageAgent's public constructor contract
  // only. hydraModelFetch ignores both and the host resolves the real selected
  // Hydra route.
  pageAgent = new PageAgentCore({
    model: 'hydra-selected-model',
    baseURL: 'http://hydra.local',
    customFetch: hydraModelFetch,
    language: 'en-US',
    pageController: controller,
    instructions: {
      system: 'You are a Hydra-controlled browser engine. Do not present a user interface or ask the webpage user questions. Keep internal task results in English for Hydra to consume.',
    },
  })
  return pageAgent
}

/**
 * Run one action against this document.
 * @param {string} action - action name, matching the extension's action set.
 * @param {Record<string, any>} args - action arguments, already JSON-safe.
 * @returns {Promise<unknown>} the action's JSON-safe result.
 */
async function dispatch(action, args) {
  const controller = await pageControllerReady
  switch (action) {
    case 'get_browser_state':
      return await controller.getBrowserState()
    case 'get_current_url':
      return await controller.getCurrentUrl()
    case 'get_last_update_time':
      return await controller.getLastUpdateTime()
    case 'update_tree': {
      const content = await controller.updateTree()
      return { content: maskPasswordValues(controller, content) }
    }
    case 'clean_up_highlights':
      await controller.cleanUpHighlights()
      return { success: true, message: 'Cleaned up PageController highlights.' }
    case 'annotate_element':
      return await pickElement(controller)
    case 'annotate_element_at': {
      const element = elementAt(undefined, Number(args.x), Number(args.y))
      if (element === undefined) throw new Error('No page element exists at the requested point.')
      return await describeElement(controller, element)
    }
    case 'click_element':
      return await actOnNamed(controller, args, (index) => {
        const covered = coveredClickFailure(controller, index)
        if (covered !== undefined) return covered
        return controller.clickElement(index)
      })
    case 'get_element_center':
      return getElementCenter(controller, args.index)
    case 'mark_file_input':
      return markFileInput(controller, args.index)
    case 'unmark_file_input':
      return unmarkFileInput(args.token)
    case 'history_state':
      return historyState()
    case 'history_go':
      return historyGo(args.delta)
    case 'input_text':
      return await actOnNamed(controller, args, index => controller.inputText(index, args.text))
    case 'select_option':
      return await actOnNamed(controller, args, index => controller.selectOption(index, args.text))
    case 'find_element':
      return await findElement(controller, args.query)
    case 'fill_fields':
      return await withVisualMask(controller, () => fillFields(controller, args.fields))
    case 'autofill_login':
      return fillLogin(args)
    case 'autofill_contact':
      return fillContact(args)
    case 'scroll':
      return await controller.scroll(args)
    case 'scroll_horizontally':
      return await controller.scrollHorizontally(args)
    case 'execute_javascript':
      return await controller.executeJavascript(args.script)
    case 'page_agent_run': {
      if (typeof args.task !== 'string' || args.task.trim().length === 0) {
        throw new Error('PageAgent task must be a non-empty string')
      }
      const agent = ensurePageAgent(controller)
      if (agent.status === 'running') {
        return { success: false, message: 'PageAgent is already running.' }
      }
      setTimeout(() => { void agent.execute(args.task).catch(error => console.error('[PageAgent]', error)) }, 0)
      return { success: true, message: 'Started the upstream PageAgent task.' }
    }
    case 'page_agent_status': {
      if (pageAgent === undefined) {
        return { success: true, message: 'PageAgent status: idle.' }
      }
      return {
        success: true,
        message: pageAgent.lastResult === null
          ? `PageAgent status: ${pageAgent.status}.`
          : `PageAgent status: ${pageAgent.status}. ${pageAgent.lastResult.data}`,
      }
    }
    case 'page_agent_stop':
      if (pageAgent !== undefined) await pageAgent.stop()
      return { success: true, message: 'Stopped the upstream PageAgent task.' }
    default:
      throw new Error(`unknown page action: ${action}`)
  }
}

ipcRenderer.on('page-control', (_event, request) => {
  dispatch(request.action, request.args ?? {}).then(
    result => ipcRenderer.send('page-control:result', { id: request.id, ok: true, result }),
    // An Error does not survive the structured clone to the main process with
    // its prototype, so the message travels as plain data.
    error => ipcRenderer.send('page-control:result', {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
})

ipcRenderer.on('page-annotation:cancel', () => { cancelActiveAnnotation?.() })
