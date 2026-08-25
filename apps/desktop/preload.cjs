'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bhDesktop', {
  browser: {
    setBounds: bounds => { ipcRenderer.send('bh-desktop:browser-bounds', bounds) },
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
    root: () => ipcRenderer.invoke('bh-desktop:files-root'),
    list: path => ipcRenderer.invoke('bh-desktop:files-list', { path }),
    read: path => ipcRenderer.invoke('bh-desktop:files-read', { path }),
  },
  panels: {
    onShortcut: listener => {
      const handler = (_event, shortcut) => { listener(shortcut) }
      ipcRenderer.on('bh-desktop:panel-shortcut', handler)
      return () => { ipcRenderer.removeListener('bh-desktop:panel-shortcut', handler) }
    },
  },
})
