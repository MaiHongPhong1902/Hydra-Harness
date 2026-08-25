'use strict'

const { createServer } = require('node:http')
const { app, BrowserWindow, webContents } = require('electron')

let server
let finished = false
let deadline
let phase = 'starting'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(25)
  }
  throw new Error('timed out waiting for browser chrome')
}

function finish(ok, error) {
  if (finished) return
  finished = true
  clearTimeout(deadline)
  process.stdout.write(`${JSON.stringify({ event: 'chrome-ui-test', ok, error: error?.message })}\n`)
  server.close()
  app.exit(ok ? 0 : 1)
}

process.on('unhandledRejection', error => finish(false, error))
process.on('uncaughtException', error => finish(false, error))

server = createServer((request, response) => {
  const title = {
    '/one': 'One',
    '/two': 'Two',
    '/three': 'Three',
  }[request.url] ?? 'Missing'
  response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`)
})

server.listen(0, '127.0.0.1', () => {
  require('../electron-app/main.cjs')
  deadline = setTimeout(() => finish(false, new Error(`driver stalled at ${phase}`)), 15_000)
  void (async () => {
    phase = 'finding chrome'
    const chrome = await waitFor(() => webContents.getAllWebContents().find(contents => contents.getURL().endsWith('/chrome.html')))
    const address = `http://127.0.0.1:${server.address().port}`
    const titles = { '/one': 'One', '/two': 'Two', '/three': 'Three' }
    const state = () => chrome.executeJavaScript(`({
      count: document.querySelectorAll('.tab-select').length,
      active: [...document.querySelectorAll('.tab-select')].find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent,
      url: document.getElementById('omnibox').value,
      forwardDisabled: document.getElementById('forward').disabled,
    })`)
    const navigate = async path => {
      phase = `navigating ${path}`
      await chrome.executeJavaScript(`
        document.getElementById('omnibox').value = ${JSON.stringify(`${address}${path}`)}
        document.getElementById('omnibox-form').requestSubmit()
      `)
      await waitFor(async () => {
        const current = await state()
        return current.url === `${address}${path}` && current.active === titles[path]
      })
    }

    phase = 'waiting for the initial tab'
    await waitFor(async () => (await state()).count === 1)
    await navigate('/one')
    phase = 'waiting for first tab title'
    await waitFor(async () => (await state()).active === 'One')
    phase = 'adding a tab'
    await chrome.executeJavaScript("document.getElementById('new-tab').click()")
    await waitFor(async () => (await state()).count === 2)
    await navigate('/two')
    await navigate('/three')
    phase = 'going back'
    await chrome.executeJavaScript("document.getElementById('back').click()")
    await waitFor(async () => (await state()).active === 'Two' && !(await state()).forwardDisabled)
    phase = 'going forward'
    await chrome.executeJavaScript("document.getElementById('forward').click()")
    await waitFor(async () => (await state()).active === 'Three')
    phase = 'selecting the first tab'
    await chrome.executeJavaScript("document.querySelectorAll('.tab-select')[0].click()")
    await waitFor(async () => (await state()).active === 'One')
    phase = 'closing the first tab'
    await chrome.executeJavaScript("document.querySelectorAll('.tab-close')[0].click()")
    await waitFor(async () => (await state()).count === 1 && (await state()).active === 'Three')
    phase = 'closing the browser window'
    app.once('window-all-closed', () => finish(true))
    BrowserWindow.getAllWindows()[0]?.close()
  })().catch(error => finish(false, error))
})
