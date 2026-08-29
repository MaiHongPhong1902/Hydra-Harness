'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bhDesktop', {
  browser: {
    setBounds: bounds => { ipcRenderer.send('bh-desktop:browser-bounds', bounds) },
    configure: settings => ipcRenderer.invoke('bh-desktop:browser-configure', settings),
    confirmFullCdpAccess: () => ipcRenderer.invoke('bh-desktop:browser-confirm-full-cdp'),
    clearData: scope => ipcRenderer.invoke('bh-desktop:browser-clear-data', { scope }),
    openUrl: url => ipcRenderer.invoke('bh-desktop:browser-open-url', { url }),
    history: () => ipcRenderer.invoke('bh-desktop:browser-history'),
    removeHistory: id => ipcRenderer.invoke('bh-desktop:browser-remove-history', { id }),
    downloads: () => ipcRenderer.invoke('bh-desktop:browser-downloads'),
    removeDownload: id => ipcRenderer.invoke('bh-desktop:browser-remove-download', { id }),
    sites: () => ipcRenderer.invoke('bh-desktop:browser-sites'),
    setSite: value => ipcRenderer.invoke('bh-desktop:browser-set-site', value),
    removeSite: origin => ipcRenderer.invoke('bh-desktop:browser-remove-site', { origin }),
    autofillStatus: () => ipcRenderer.invoke('bh-desktop:browser-autofill-status'),
    autofillListLogins: () => ipcRenderer.invoke('bh-desktop:browser-autofill-list-logins'),
    autofillSaveLogin: value => ipcRenderer.invoke('bh-desktop:browser-autofill-save-login', value),
    autofillRemoveLogin: id => ipcRenderer.invoke('bh-desktop:browser-autofill-remove-login', { id }),
    autofillListContacts: () => ipcRenderer.invoke('bh-desktop:browser-autofill-list-contacts'),
    autofillGetContact: id => ipcRenderer.invoke('bh-desktop:browser-autofill-get-contact', { id }),
    autofillSaveContact: value => ipcRenderer.invoke('bh-desktop:browser-autofill-save-contact', value),
    autofillRemoveContact: id => ipcRenderer.invoke('bh-desktop:browser-autofill-remove-contact', { id }),
    onAnnotation(listener) {
      const handler = (_event, annotation) => { listener(annotation) }
      ipcRenderer.on('bh-desktop:browser-annotation', handler)
      return () => { ipcRenderer.removeListener('bh-desktop:browser-annotation', handler) }
    },
  },
  terminal: {
    start: (terminalId, size) => ipcRenderer.invoke('bh-desktop:terminal-start', { terminalId, size }),
    stop: terminalId => ipcRenderer.invoke('bh-desktop:terminal-stop', { terminalId }),
    write: (terminalId, data) => { ipcRenderer.send('bh-desktop:terminal-write', { terminalId, data }) },
    resize: (terminalId, size) => { ipcRenderer.send('bh-desktop:terminal-resize', { terminalId, size }) },
    onEvent(terminalId, listener) {
      const handler = (_event, value) => {
        if (value?.terminalId === terminalId) listener(value.event)
      }
      ipcRenderer.on('bh-desktop:terminal-event', handler)
      return () => { ipcRenderer.removeListener('bh-desktop:terminal-event', handler) }
    },
  },
  files: {
    root: workspaceId => ipcRenderer.invoke('bh-desktop:files-root', { workspaceId }),
    list: (path, workspaceId) => ipcRenderer.invoke('bh-desktop:files-list', { path, workspaceId }),
    search: (query, workspaceId) => ipcRenderer.invoke('bh-desktop:files-search', { query, workspaceId }),
    read: (path, workspaceId) => ipcRenderer.invoke('bh-desktop:files-read', { path, workspaceId }),
    create: (parentPath, name, kind, workspaceId) =>
      ipcRenderer.invoke('bh-desktop:files-create', { parentPath, name, kind, workspaceId }),
    save: (path, content, expectedVersion, workspaceId) =>
      ipcRenderer.invoke('bh-desktop:files-save', { path, content, expectedVersion, workspaceId }),
    format: (path, content, workspaceId) =>
      ipcRenderer.invoke('bh-desktop:files-format', { path, content, workspaceId }),
  },
  panels: {
    onShortcut: listener => {
      const handler = (_event, shortcut) => { listener(shortcut) }
      ipcRenderer.on('bh-desktop:panel-shortcut', handler)
      return () => { ipcRenderer.removeListener('bh-desktop:panel-shortcut', handler) }
    },
  },
})
