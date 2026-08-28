'use strict'

const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const tabs = document.getElementById('tabs')
  const newTab = document.getElementById('new-tab')
  const back = document.getElementById('back')
  const forward = document.getElementById('forward')
  const reload = document.getElementById('reload')
  const annotate = document.getElementById('annotate')
  const form = document.getElementById('omnibox-form')
  const omnibox = document.getElementById('omnibox')
  const omniboxHistory = document.getElementById('omnibox-history')

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

  const renderHistory = entries => {
    omniboxHistory.replaceChildren(...entries.map(({ title, url }) => {
      const option = document.createElement('option')
      option.value = url
      option.label = title
      return option
    }))
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    if (omnibox.value.trim()) ipcRenderer.send('browser-chrome:navigate', omnibox.value)
  })
  newTab.addEventListener('click', () => ipcRenderer.send('browser-chrome:new-tab'))
  back.addEventListener('click', () => ipcRenderer.send('browser-chrome:back'))
  forward.addEventListener('click', () => ipcRenderer.send('browser-chrome:forward'))
  reload.addEventListener('click', () => ipcRenderer.send('browser-chrome:reload'))
  annotate.addEventListener('click', () => {
    if (annotate.getAttribute('aria-pressed') === 'true') {
      ipcRenderer.send('browser-chrome:cancel-annotation')
      return
    }
    annotate.setAttribute('aria-pressed', 'true')
    ipcRenderer.send('browser-chrome:annotate')
  })
  ipcRenderer.on('browser-chrome:annotation-ended', () => { annotate.setAttribute('aria-pressed', 'false') })
  ipcRenderer.on('browser-chrome:update', (_event, state) => {
    renderTabs(state)
    renderHistory(state.history)
    back.disabled = !state.canGoBack
    forward.disabled = !state.canGoForward
    annotate.disabled = !state.annotationEnabled
    if (document.activeElement !== omnibox) omnibox.value = state.url
  })
})
