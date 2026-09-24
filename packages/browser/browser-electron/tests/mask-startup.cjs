'use strict'

// Exercise the shipped sandboxed preload while an unfinished document holds controller startup.
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const config = JSON.parse(process.argv[2])
app.setPath('userData', config.userDataDir)
const preload = join(config.userDataDir, 'mask-preload.cjs')
writeFileSync(preload, readFileSync(join(__dirname, '../electron-app/preload.cjs'), 'utf8') + `
;require('electron').ipcRenderer.on('browser:activity', (_event, active) => {
  require('electron').ipcRenderer.send('mask-test:activity', { active, loading: document.readyState === 'loading' })
})
require('electron').ipcRenderer.send('mask-test:installed')
`)

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.write('<!doctype html><title>Browser mask startup</title><body><h1>Browser mask startup</h1>')
  ipcMain.once('mask-test:activity', (_event, state) => {
    assert.deepEqual(state, { active: true, loading: true })
    response.end('</body>')
  })
})

async function run() {
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } })
  ipcMain.once('mask-test:installed', event => { event.sender.send('browser:activity', true) })
  await window.loadURL(`http://127.0.0.1:${server.address().port}`)
  const ready = new Promise(resolve => ipcMain.once('page-control:result', (_event, reply) => resolve(reply)))
  window.webContents.send('page-control', { id: 1, action: 'get_current_url' })
  assert.equal((await ready).ok, true)
  const active = await window.webContents.executeJavaScript(`(() => {
    const mask = document.querySelector('#page-agent-runtime_simulator-mask')
    return { active: mask.hasAttribute('data-hydra-active'), cursor: Boolean(mask.lastElementChild), motion: Boolean(mask.querySelector('canvas')) }
  })()`)
  assert.deepEqual(active, { active: true, cursor: true, motion: true })
  const cleared = new Promise(resolve => ipcMain.once('mask-test:activity', (_event, state) => resolve(state)))
  window.webContents.send('browser:activity', false)
  assert.deepEqual(await cleared, { active: false, loading: false })
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#page-agent-runtime_simulator-mask').hasAttribute('data-hydra-active')"), false)
  process.stdout.write(JSON.stringify({ event: 'chrome-ui-test', ok: true, transcript: active }) + '\n')
}

const timeout = setTimeout(() => { console.error('mask startup timed out'); app.exit(1) }, 20_000)
run().then(() => { clearTimeout(timeout); server.close(); app.exit(0) }, error => {
  console.error(error)
  server.close()
  app.exit(1)
})
