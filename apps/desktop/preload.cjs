'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hydraDesktop', {
  browser: {
    setBounds: bounds => { ipcRenderer.send('hydra-desktop:browser-bounds', bounds) },
    setTheme: theme => { ipcRenderer.send('hydra-desktop:browser-theme', theme) },
    configure: settings => ipcRenderer.invoke('hydra-desktop:browser-configure', settings),
    confirmFullCdpAccess: () => ipcRenderer.invoke('hydra-desktop:browser-confirm-full-cdp'),
    clearData: scope => ipcRenderer.invoke('hydra-desktop:browser-clear-data', { scope }),
    openUrl: url => ipcRenderer.invoke('hydra-desktop:browser-open-url', { url }),
    history: () => ipcRenderer.invoke('hydra-desktop:browser-history'),
    removeHistory: id => ipcRenderer.invoke('hydra-desktop:browser-remove-history', { id }),
    downloads: () => ipcRenderer.invoke('hydra-desktop:browser-downloads'),
    removeDownload: id => ipcRenderer.invoke('hydra-desktop:browser-remove-download', { id }),
    sites: () => ipcRenderer.invoke('hydra-desktop:browser-sites'),
    setSite: value => ipcRenderer.invoke('hydra-desktop:browser-set-site', value),
    removeSite: origin => ipcRenderer.invoke('hydra-desktop:browser-remove-site', { origin }),
    autofillStatus: () => ipcRenderer.invoke('hydra-desktop:browser-autofill-status'),
    autofillListLogins: () => ipcRenderer.invoke('hydra-desktop:browser-autofill-list-logins'),
    autofillSaveLogin: value => ipcRenderer.invoke('hydra-desktop:browser-autofill-save-login', value),
    autofillRemoveLogin: id => ipcRenderer.invoke('hydra-desktop:browser-autofill-remove-login', { id }),
    autofillListContacts: () => ipcRenderer.invoke('hydra-desktop:browser-autofill-list-contacts'),
    autofillGetContact: id => ipcRenderer.invoke('hydra-desktop:browser-autofill-get-contact', { id }),
    autofillSaveContact: value => ipcRenderer.invoke('hydra-desktop:browser-autofill-save-contact', value),
    autofillRemoveContact: id => ipcRenderer.invoke('hydra-desktop:browser-autofill-remove-contact', { id }),
    onAnnotation(listener) {
      const handler = (_event, annotation) => { listener(annotation) }
      ipcRenderer.on('hydra-desktop:browser-annotation', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:browser-annotation', handler) }
    },
  },
  terminal: {
    start: (terminalId, size) => ipcRenderer.invoke('hydra-desktop:terminal-start', { terminalId, size }),
    stop: terminalId => ipcRenderer.invoke('hydra-desktop:terminal-stop', { terminalId }),
    write: (terminalId, data) => { ipcRenderer.send('hydra-desktop:terminal-write', { terminalId, data }) },
    resize: (terminalId, size) => { ipcRenderer.send('hydra-desktop:terminal-resize', { terminalId, size }) },
    onEvent(terminalId, listener) {
      const handler = (_event, value) => {
        if (value?.terminalId === terminalId) listener(value.event)
      }
      ipcRenderer.on('hydra-desktop:terminal-event', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:terminal-event', handler) }
    },
  },
  files: {
    root: workspaceId => ipcRenderer.invoke('hydra-desktop:files-root', { workspaceId }),
    list: (path, workspaceId) => ipcRenderer.invoke('hydra-desktop:files-list', { path, workspaceId }),
    search: (query, workspaceId) => ipcRenderer.invoke('hydra-desktop:files-search', { query, workspaceId }),
    read: (path, workspaceId) => ipcRenderer.invoke('hydra-desktop:files-read', { path, workspaceId }),
    create: (parentPath, name, kind, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-create', { parentPath, name, kind, workspaceId }),
    rename: (path, newName, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-rename', { path, newName, workspaceId }),
    delete: (path, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-delete', { path, workspaceId }),
    reveal: (path, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-reveal', { path, workspaceId }),
    save: (path, content, expectedVersion, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-save', { path, content, expectedVersion, workspaceId }),
    format: (path, content, workspaceId) =>
      ipcRenderer.invoke('hydra-desktop:files-format', { path, content, workspaceId }),
  },
  panels: {
    onShortcut: listener => {
      const handler = (_event, shortcut) => { listener(shortcut) }
      ipcRenderer.on('hydra-desktop:panel-shortcut', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:panel-shortcut', handler) }
    },
    onClose: listener => {
      const handler = (_event, kind) => { listener(kind) }
      ipcRenderer.on('hydra-desktop:panel-close', handler)
      return () => { ipcRenderer.removeListener('hydra-desktop:panel-close', handler) }
    },
  },
})
