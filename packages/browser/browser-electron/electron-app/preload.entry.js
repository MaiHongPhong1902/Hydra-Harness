// Source of `preload.cjs` — do not load this file directly; Electron loads the
// bundle. Rebuild with `pnpm --filter @bosch/bh-browser-electron run build:preload`.
//
// This is the Electron counterpart of PageAgent's content script. It runs the
// upstream PageAgent engine (Core and PageController) in the isolated world of
// every document the controlled view loads. BH owns all user-visible controls;
// the upstream Panel is deliberately not instantiated. Its simulator mask is
// visual feedback only and appears while BH performs an indexed DOM action. Its
// LLM fetches cross the private IPC boundary and are routed by BH to the model
// the owning agent already selected; no provider credential reaches the webpage.
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

const annotationCss = `
#bh-browser-annotation-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  cursor: crosshair;
  background: transparent;
}
#bh-browser-annotation-overlay[data-peeking="true"] { pointer-events: none; }
#bh-browser-annotation-highlight {
  position: fixed;
  z-index: 2147483646;
  box-sizing: border-box;
  pointer-events: none;
  border: 2px solid #0096e8;
  border-radius: 4px;
  background: rgb(0 150 232 / 12%);
}
#bh-browser-annotation-tip {
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

let cancelActiveAnnotation

/** A constructed stylesheet works when the page's CSP blocks inline style tags. */
function installMaskStyles() {
  const stylesheet = new CSSStyleSheet()
  stylesheet.replaceSync(`${maskCss}\n${cursorCss}\n${annotationCss}`)
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
  return {
    kind: 'browser-element',
    url: annotationUrl(),
    title: clippedText(document.title, 160),
    ...(index === undefined ? {} : { index }),
    preview: clippedText(text
      ? `<${tag}${attributes}>${escapeHtml(text)}</${tag}>`
      : `<${tag}${attributes} />`, 1_024),
  }
}

/** Read the page element under a picker point without selecting our overlay. */
function elementAt(overlay, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  overlay?.setAttribute('data-peeking', 'true')
  const element = document.elementFromPoint(x, y)
  overlay?.removeAttribute('data-peeking')
  return element instanceof Element ? element : undefined
}

/** Enter a one-shot element picker; Escape, navigation, or a tab switch cancels it. */
function pickElement(controller) {
  cancelActiveAnnotation?.()
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    const highlight = document.createElement('div')
    const tip = document.createElement('div')
    overlay.id = 'bh-browser-annotation-overlay'
    highlight.id = 'bh-browser-annotation-highlight'
    tip.id = 'bh-browser-annotation-tip'
    tip.textContent = 'Select an element · Esc to cancel'
    for (const node of [overlay, highlight, tip]) node.dataset.pageAgentIgnore = 'true'

    let current
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
    overlay.addEventListener('pointermove', event => { pointTo(event.clientX, event.clientY) })
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

/** Bridge PageAgent's OpenAI-shaped request to BH without exposing an API key. */
async function bhModelFetch(_input, init = {}) {
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

/** Show the passive visual feedback around a BH-owned indexed DOM action. */
async function withVisualMask(controller, action) {
  await controller.showMask()
  try {
    return await action()
  } finally {
    await controller.hideMask()
  }
}

// Electron evaluates a preload before navigation creates <body>. Wait for a
// document before constructing PageController. The engine runs privately; the
// BH tool surface is the sole control plane.
const pageAgentReady = new Promise((resolve, reject) => {
  const initialize = () => {
    try {
      installMaskStyles()
      // `model` and `baseURL` satisfy PageAgent's public constructor contract
      // only. bhModelFetch ignores both and the host resolves the real selected
      // BH route.
      const pageController = new PageController({ enableMask: true })
      const pageAgent = new PageAgentCore({
        model: 'bh-selected-model',
        baseURL: 'http://bh.local',
        customFetch: bhModelFetch,
        language: 'en-US',
        pageController,
        instructions: {
          system: 'You are a BH-controlled browser engine. Do not present a user interface or ask the webpage user questions. Keep internal task results in English for BH to consume.',
        },
      })
      resolve(pageAgent)
    } catch (error) {
      reject(error)
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true })
  else initialize()
})

/**
 * Run one action against this document.
 * @param {string} action - action name, matching the extension's action set.
 * @param {Record<string, any>} args - action arguments, already JSON-safe.
 * @returns {Promise<unknown>} the action's JSON-safe result.
 */
async function dispatch(action, args) {
  const pageAgent = await pageAgentReady
  const controller = pageAgent.pageController
  switch (action) {
    case 'get_browser_state':
      return await controller.getBrowserState()
    case 'get_current_url':
      return await controller.getCurrentUrl()
    case 'get_last_update_time':
      return await controller.getLastUpdateTime()
    case 'update_tree':
      return { content: await controller.updateTree() }
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
      return await withVisualMask(controller, () => controller.clickElement(args.index))
    case 'get_element_center':
      return getElementCenter(controller, args.index)
    case 'input_text':
      return await withVisualMask(controller, () => controller.inputText(args.index, args.text))
    case 'select_option':
      return await withVisualMask(controller, () => controller.selectOption(args.index, args.text))
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
      if (pageAgent.status === 'running') {
        return { success: false, message: 'PageAgent is already running.' }
      }
      setTimeout(() => { void pageAgent.execute(args.task).catch(error => console.error('[PageAgent]', error)) }, 0)
      return { success: true, message: 'Started the upstream PageAgent task.' }
    }
    case 'page_agent_status':
      return {
        success: true,
        message: pageAgent.lastResult === null
          ? `PageAgent status: ${pageAgent.status}.`
          : `PageAgent status: ${pageAgent.status}. ${pageAgent.lastResult.data}`,
      }
    case 'page_agent_stop':
      await pageAgent.stop()
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
