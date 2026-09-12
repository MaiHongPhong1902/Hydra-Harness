// Connect Playwright to one Hydra-owned Electron debugger, without a TCP endpoint.
'use strict'

const { chromium } = require('playwright-core')

/**
 * Adapt Electron's page debugger to Playwright's browser/session CDP transport.
 * The synthetic root announces only this controlled page; child CDP sessions
 * retain Chromium's ids. Closing the transport does not close the user's tab.
 * @param {Electron.WebContents} contents - live controlled page with an attached debugger.
 * @param {number} timeout - connection and action timeout in milliseconds.
 * @returns {Promise<import('playwright-core').Page>} the page backed by this debugger.
 */
async function connectPlaywrightPage(contents, timeout) {
  const debuggerApi = contents.debugger
  const { targetInfo: info } = await debuggerApi.sendCommand('Target.getTargetInfo')
  const targetInfo = { ...info, browserContextId: undefined }
  const rootSession = `hydra-${contents.id}`
  let closed = false
  const transport = {
    send(message) {
      if (closed) return
      void dispatch(message).then(
        result => emit({ id: message.id, sessionId: message.sessionId, result }),
        error => emit({ id: message.id, sessionId: message.sessionId, error: { message: error.message } }),
      )
    },
    close() {
      if (closed) return
      closed = true
      debuggerApi.removeListener('message', onMessage)
      debuggerApi.removeListener('detach', onDetach)
      contents.removeListener('destroyed', onDetach)
      transport.onclose?.()
    },
  }
  function emit(message) {
    if (!closed) transport.onmessage?.(message)
  }
  async function dispatch({ method, params, sessionId }) {
    if (!sessionId && method === 'Target.setAutoAttach') {
      emit({ method: 'Target.attachedToTarget', params: { sessionId: rootSession, targetInfo, waitingForDebugger: false } })
      return {}
    }
    if (!sessionId && method === 'Target.getTargetInfo') return { targetInfo }
    // Tab/window creation and browser settings remain owned by Electron.
    if (!sessionId && method !== 'Browser.getVersion') throw new Error(`Unsupported browser command: ${method}`)
    return await debuggerApi.sendCommand(method, params, sessionId === rootSession ? undefined : sessionId)
  }
  function onMessage(_event, method, params, sessionId) {
    emit({ sessionId: sessionId || rootSession, method, params })
  }
  function onDetach() {
    transport.close()
  }
  debuggerApi.on('message', onMessage)
  debuggerApi.on('detach', onDetach)
  contents.once('destroyed', onDetach)
  try {
    const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout })
    const page = browser.contexts()[0]?.pages()[0]
    if (!page) throw new Error('Playwright did not attach to the controlled page')
    page.setDefaultTimeout(timeout)
    return page
  } catch (error) {
    transport.close()
    throw error
  }
}

module.exports = { connectPlaywrightPage }
