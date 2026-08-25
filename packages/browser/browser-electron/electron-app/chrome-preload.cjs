'use strict'

const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const tabs = document.getElementById('tabs')
  const newTab = document.getElementById('new-tab')
  const back = document.getElementById('back')
  const forward = document.getElementById('forward')
  const reload = document.getElementById('reload')
  const form = document.getElementById('omnibox-form')
  const omnibox = document.getElementById('omnibox')

  const renderTabs = state => {
    tabs.replaceChildren()
    for (const { id, title } of state.tabs) {
      const tab = document.createElement('div')
      tab.className = 'tab'
      tab.setAttribute('aria-selected', String(id === state.activeTabId))
      const select = document.createElement('button')
      select.className = 'tab-select'
      select.type = 'button'
      select.setAttribute('role', 'tab')
      select.setAttribute('aria-selected', String(id === state.activeTabId))
      select.textContent = title
      select.title = title
      select.addEventListener('click', () => ipcRenderer.send('browser-chrome:select-tab', id))
      const close = document.createElement('button')
      close.className = 'tab-close'
      close.type = 'button'
      close.setAttribute('aria-label', `Close ${title}`)
      close.title = `Close ${title}`
      close.textContent = '×'
      close.addEventListener('click', () => ipcRenderer.send('browser-chrome:close-tab', id))
      tab.append(select, close)
      tabs.append(tab)
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    if (omnibox.value.trim()) ipcRenderer.send('browser-chrome:navigate', omnibox.value)
  })
  newTab.addEventListener('click', () => ipcRenderer.send('browser-chrome:new-tab'))
  back.addEventListener('click', () => ipcRenderer.send('browser-chrome:back'))
  forward.addEventListener('click', () => ipcRenderer.send('browser-chrome:forward'))
  reload.addEventListener('click', () => ipcRenderer.send('browser-chrome:reload'))
  ipcRenderer.on('browser-chrome:update', (_event, state) => {
    renderTabs(state)
    back.disabled = !state.canGoBack
    forward.disabled = !state.canGoForward
    if (document.activeElement !== omnibox) omnibox.value = state.url
  })
})
