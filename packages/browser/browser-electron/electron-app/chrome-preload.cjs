'use strict'

const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const tabs = document.getElementById('tabs')
  const newTab = document.getElementById('new-tab')
  const back = document.getElementById('back')
  const forward = document.getElementById('forward')
  const reload = document.getElementById('reload')
  const reloadIcon = document.getElementById('reload-icon')
  const stopIcon = document.getElementById('stop-icon')
  const home = document.getElementById('home')
  const annotate = document.getElementById('annotate')
  const form = document.getElementById('omnibox-form')
  const omnibox = document.getElementById('omnibox')
  const clearOmnibox = document.getElementById('clear-omnibox')
  const bookmarkStar = document.getElementById('bookmark-star')
  const zoomBadge = document.getElementById('zoom-badge')
  const securityBadge = document.getElementById('security-badge')
  const secure = document.getElementById('secure')
  const insecureIcon = document.getElementById('insecure-icon')
  const omniboxHistory = document.getElementById('omnibox-history')
  const bookmarksBar = document.getElementById('bookmarks-bar')
  const findToggle = document.getElementById('find-toggle')
  const findBar = document.getElementById('find-bar')
  const findInput = document.getElementById('find-input')
  const findCount = document.getElementById('find-count')
  const findPrev = document.getElementById('find-prev')
  const findNext = document.getElementById('find-next')
  const findClose = document.getElementById('find-close')
  const siteInfoCard = document.getElementById('site-info-card')
  const siteInfoTitle = document.getElementById('site-info-title')
  const siteInfoBody = document.getElementById('site-info-body')
  const siteInfoClose = document.getElementById('site-info-close')
  const status = document.getElementById('status')
  const loading = document.getElementById('loading')

  let isPageLoading = false
  let currentTabUrl = ''

  const themeColorFields = [
    'shell', 'tabstrip', 'surface', 'text', 'muted', 'hover', 'border',
    'accent', 'accentText', 'omnibox', 'status',
  ]

  const applyTheme = (theme, colors) => {
    const scheme = theme === 'dark' ? 'dark' : 'light'
    document.documentElement.dataset.theme = scheme
    document.documentElement.style.colorScheme = scheme
    for (const field of themeColorFields) {
      const property = `--chrome-${field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
      document.documentElement.style.removeProperty(property)
      if (typeof colors?.[field] === 'string') document.documentElement.style.setProperty(property, colors[field])
    }
  }

  const renderTabs = state => {
    const focused = document.hasFocus() && tabs.contains(document.activeElement) ? document.activeElement : undefined
    const focusedTab = focused?.closest('.tab')?.dataset.tabId
    const focusedControl = focused?.className
    tabs.replaceChildren()
    for (const { id, title, favicon, isAudible, isMuted, isLoading } of state.tabs) {
      const tab = document.createElement('div')
      tab.className = 'tab'
      tab.dataset.tabId = String(id)
      tab.setAttribute('aria-selected', String(id === state.activeTabId))

      // Tab icon / spinner
      if (isLoading) {
        const spinner = document.createElement('span')
        spinner.className = 'tab-spinner'
        tab.append(spinner)
      } else {
        const icon = document.createElement('img')
        icon.className = 'tab-favicon'
        icon.alt = ''
        if (typeof favicon === 'string' && favicon.length > 0) {
          icon.src = favicon
          icon.addEventListener('error', () => { icon.hidden = true })
        } else {
          icon.hidden = true
        }
        tab.append(icon)
      }

      // Tab title button
      const select = document.createElement('button')
      select.className = 'tab-select'
      select.type = 'button'
      select.setAttribute('role', 'tab')
      select.setAttribute('aria-selected', String(id === state.activeTabId))
      select.textContent = title
      select.title = title
      select.addEventListener('click', () => ipcRenderer.send('browser-chrome:select-tab', id))
      tab.append(select)

      // Audio mute indicator
      if (isAudible || isMuted) {
        const audioBtn = document.createElement('button')
        audioBtn.className = 'tab-audio'
        audioBtn.type = 'button'
        audioBtn.title = isMuted ? 'Unmute tab' : 'Mute tab'
        audioBtn.textContent = isMuted ? '🔇' : '🔊'
        audioBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          ipcRenderer.send('browser-chrome:toggle-mute', id)
        })
        tab.append(audioBtn)
      }

      // Close tab button
      const close = document.createElement('button')
      close.className = 'tab-close'
      close.type = 'button'
      close.setAttribute('aria-label', `Close ${title}`)
      close.title = `Close ${title} (Ctrl+W)`
      close.textContent = '×'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        ipcRenderer.send('browser-chrome:close-tab', id)
      })
      tab.append(close)

      // Context menu on tab
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        ipcRenderer.send('browser-chrome:tab-context-menu', id)
      })

      tabs.append(tab)
      if (String(id) === focusedTab) {
        Array.from(tab.children).find(element => element.className === focusedControl)?.focus({ preventScroll: true })
      }
    }
    const selected = tabs.querySelector('.tab[aria-selected="true"]')
    if (focused && !tabs.contains(document.activeElement)) selected?.querySelector('.tab-select')?.focus({ preventScroll: true })
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const renderBookmarks = (bookmarks = []) => {
    if (!bookmarksBar) return
    if (!bookmarks || bookmarks.length === 0) {
      bookmarksBar.hidden = true
      return
    }
    bookmarksBar.hidden = false
    bookmarksBar.replaceChildren(...bookmarks.map(bm => {
      const btn = document.createElement('button')
      btn.className = 'bookmark-item'
      btn.type = 'button'
      btn.title = `${bm.title}\n${bm.url}`

      if (bm.favicon) {
        const img = document.createElement('img')
        img.className = 'bookmark-favicon'
        img.src = bm.favicon
        img.alt = ''
        img.addEventListener('error', () => { img.remove() })
        btn.append(img)
      }

      const label = document.createElement('span')
      label.textContent = bm.title || bm.url
      btn.append(label)

      btn.addEventListener('click', () => {
        ipcRenderer.send('browser-chrome:navigate', bm.url)
      })
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        ipcRenderer.send('browser-chrome:remove-bookmark', bm.id)
      })
      return btn
    }))
  }

  const renderHistory = entries => {
    if (!omniboxHistory) return
    omniboxHistory.replaceChildren(...entries.map(({ title, url }) => {
      const option = document.createElement('option')
      option.value = url
      option.label = title
      return option
    }))
  }

  // Navigation handlers
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (omnibox.value.trim()) ipcRenderer.send('browser-chrome:navigate', omnibox.value)
  })

  // Select all on focus
  omnibox.addEventListener('focus', () => {
    omnibox.select()
    if (omnibox.value) clearOmnibox.hidden = false
  })
  omnibox.addEventListener('blur', () => {
    setTimeout(() => { clearOmnibox.hidden = true }, 200)
  })
  omnibox.addEventListener('input', () => {
    clearOmnibox.hidden = !omnibox.value
  })
  clearOmnibox.addEventListener('click', () => {
    omnibox.value = ''
    omnibox.focus()
    clearOmnibox.hidden = true
  })

  // Bookmark star toggle
  bookmarkStar.addEventListener('click', () => {
    ipcRenderer.send('browser-chrome:toggle-bookmark')
  })

  // Zoom badge reset
  zoomBadge.addEventListener('click', () => {
    ipcRenderer.send('browser-chrome:zoom', 'reset')
  })

  // Security badge / Site Info
  securityBadge.addEventListener('click', (e) => {
    e.stopPropagation()
    siteInfoCard.hidden = !siteInfoCard.hidden
    if (!siteInfoCard.hidden && currentTabUrl) {
      try {
        const parsed = new URL(currentTabUrl)
        siteInfoTitle.textContent = parsed.hostname || 'Site Information'
        siteInfoBody.textContent = currentTabUrl.startsWith('https:')
          ? `🔒 Connection is secure.\nYour information (such as passwords or credit card numbers) is private when it is sent to this site.`
          : `⚠️ Connection is not secure.\nYou should not enter any sensitive information on this site.`
      } catch {
        siteInfoTitle.textContent = 'Site Information'
        siteInfoBody.textContent = 'Local or internal browser page.'
      }
    }
  })
  siteInfoClose.addEventListener('click', () => { siteInfoCard.hidden = true })
  document.addEventListener('click', (e) => {
    if (!siteInfoCard.contains(e.target) && e.target !== securityBadge) {
      siteInfoCard.hidden = true
    }
  })

  newTab.addEventListener('click', () => ipcRenderer.send('browser-chrome:new-tab'))
  back.addEventListener('click', () => ipcRenderer.send('browser-chrome:back'))
  forward.addEventListener('click', () => ipcRenderer.send('browser-chrome:forward'))

  // Reload / Stop button
  reload.addEventListener('click', (e) => {
    if (isPageLoading) {
      ipcRenderer.send('browser-chrome:stop')
    } else if (e.shiftKey) {
      ipcRenderer.send('browser-chrome:hard-reload')
    } else {
      ipcRenderer.send('browser-chrome:reload')
    }
  })
  reload.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    ipcRenderer.send('browser-chrome:hard-reload')
  })

  home.addEventListener('click', () => ipcRenderer.send('browser-chrome:home'))

  // Menu button
  document.getElementById('menu-button').addEventListener('click', () => {
    ipcRenderer.send('browser-chrome:open-menu')
  })

  // Find in page controls
  const openFind = () => {
    findBar.hidden = false
    findInput.focus()
    findInput.select()
  }
  const closeFind = () => {
    findBar.hidden = true
    ipcRenderer.send('browser-chrome:stop-find')
  }
  findToggle.addEventListener('click', () => {
    if (findBar.hidden) openFind()
    else closeFind()
  })
  findClose.addEventListener('click', closeFind)
  findInput.addEventListener('input', () => {
    const text = findInput.value.trim()
    if (text) ipcRenderer.send('browser-chrome:find-in-page', text, true)
    else {
      findCount.textContent = '0/0'
      ipcRenderer.send('browser-chrome:stop-find')
    }
  })
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const text = findInput.value.trim()
      if (text) ipcRenderer.send('browser-chrome:find-in-page', text, !e.shiftKey)
    } else if (e.key === 'Escape') {
      closeFind()
    }
  })
  findPrev.addEventListener('click', () => {
    const text = findInput.value.trim()
    if (text) ipcRenderer.send('browser-chrome:find-in-page', text, false)
  })
  findNext.addEventListener('click', () => {
    const text = findInput.value.trim()
    if (text) ipcRenderer.send('browser-chrome:find-in-page', text, true)
  })

  // IPC listeners from main process
  ipcRenderer.on('browser-chrome:show-find', () => openFind())
  ipcRenderer.on('browser-chrome:focus-omnibox', () => {
    omnibox.focus()
    omnibox.select()
  })
  ipcRenderer.on('browser-chrome:found-in-page', (_event, result) => {
    if (result && typeof result.matches === 'number') {
      findCount.textContent = `${result.activeMatchOrdinal || 0}/${result.matches}`
    }
  })

  // Annotate
  annotate.addEventListener('click', () => {
    if (annotate.getAttribute('aria-pressed') === 'true') {
      ipcRenderer.send('browser-chrome:cancel-annotation')
      return
    }
    annotate.setAttribute('aria-pressed', 'true')
    ipcRenderer.send('browser-chrome:annotate')
  })
  ipcRenderer.on('browser-chrome:annotation-ended', () => { annotate.setAttribute('aria-pressed', 'false') })

  // State update
  ipcRenderer.on('browser-chrome:update', (_event, state) => {
    applyTheme(state.theme, state.themeColors)
    renderTabs(state)
    renderHistory(state.history)
    renderBookmarks(state.bookmarks)

    isPageLoading = state.loading
    currentTabUrl = state.url

    back.disabled = !state.canGoBack
    forward.disabled = !state.canGoForward
    annotate.disabled = !state.annotationEnabled
    loading.hidden = !state.loading

    // Reload / Stop toggle icon
    if (state.loading) {
      reloadIcon.hidden = true
      stopIcon.hidden = false
      reload.setAttribute('aria-label', 'Stop')
      reload.title = 'Stop loading this page (Esc)'
    } else {
      reloadIcon.hidden = false
      stopIcon.hidden = true
      reload.setAttribute('aria-label', 'Reload')
      reload.title = 'Reload page (Ctrl+R)'
    }

    // Security badge
    secure.hidden = !state.secure || state.loading
    const isSpecial = state.url.startsWith('about:') || state.url.startsWith('chrome:')
    if (state.secure) {
      securityBadge.className = 'security-btn secure'
      insecureIcon.hidden = true
    } else if (isSpecial) {
      securityBadge.className = 'security-btn'
      insecureIcon.hidden = true
    } else {
      securityBadge.className = 'security-btn insecure'
      insecureIcon.hidden = state.loading
    }

    // Bookmarks active indicator
    if (state.isBookmarked) {
      bookmarkStar.classList.add('bookmarked')
      bookmarkStar.title = 'Remove bookmark (Ctrl+D)'
      bookmarkStar.querySelector('polygon')?.setAttribute('fill', 'currentColor')
    } else {
      bookmarkStar.classList.remove('bookmarked')
      bookmarkStar.title = 'Bookmark this tab (Ctrl+D)'
      bookmarkStar.querySelector('polygon')?.setAttribute('fill', 'none')
    }

    // Zoom badge
    if (state.zoomPercent && state.zoomPercent !== 100) {
      zoomBadge.hidden = false
      zoomBadge.textContent = `${state.zoomPercent}%`
    } else {
      zoomBadge.hidden = true
    }

    // Agent status
    if (typeof state.activity === 'string' && state.activity.length > 0) {
      status.hidden = false
      status.textContent = state.activity
    } else {
      status.hidden = true
      status.textContent = ''
    }

    if (document.activeElement !== omnibox) {
      omnibox.value = state.url
      clearOmnibox.hidden = true
    }
  })
})
