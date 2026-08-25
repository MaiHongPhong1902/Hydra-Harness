/** Desktop-only interactive terminal backed by the Electron preload bridge. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import './xterm.css'
import css from './DesktopTerminalPanel.module.css'

function terminalTheme(element: HTMLElement) {
  const style = getComputedStyle(element)
  return {
    background: style.getPropertyValue('--dsw-alias-bg-base').trim(),
    foreground: style.getPropertyValue('--dsw-alias-label-primary').trim(),
    cursor: style.getPropertyValue('--dsw-alias-state-business-primary').trim(),
    selectionBackground: style.getPropertyValue('--dsw-alias-interactive-bg-active').trim(),
  }
}

function terminalSize(terminal: Terminal) {
  return { cols: Math.max(2, terminal.cols), rows: Math.max(1, terminal.rows) }
}

/** One persistent xterm surface; hiding the panel never destroys its PTY. */
export function DesktopTerminalPanel({
  open,
  terminalId = 'bottom',
  embedded = false,
}: {
  open: boolean
  terminalId?: 'bottom' | 'right'
  embedded?: boolean
}) {
  const api = window.bhDesktop?.terminal
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [running, setRunning] = useState(false)

  const start = useCallback(() => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (api === undefined || terminal === null || fit === null) return
    fit.fit()
    void api.start(terminalId, terminalSize(terminal)).then((state) => {
      setRunning(state.running)
      terminal.focus()
    }).catch((error: unknown) => {
      terminal.writeln(`\r\nTerminal failed to start: ${String(error)}`)
      setRunning(false)
    })
  }, [api, terminalId])

  useEffect(() => {
    const host = hostRef.current
    if (api === undefined || host === null) return
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, SFMono-Regular, Consolas, Liberation Mono, monospace',
      fontSize: 12,
      screenReaderMode: true,
      scrollback: 5_000,
      theme: terminalTheme(host),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit
    const data = terminal.onData((value) => { api.write(terminalId, value) })
    const unsubscribe = api.onEvent(terminalId, (event) => {
      if (event.type === 'data') terminal.write(event.data)
      else setRunning(false)
    })
    const observer = new ResizeObserver(() => {
      if (host.hidden || host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      api.resize(terminalId, terminalSize(terminal))
    })
    observer.observe(host)
    return () => {
      observer.disconnect()
      unsubscribe()
      data.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [api, terminalId])

  useEffect(() => {
    if (!open || api === undefined) return
    const frame = requestAnimationFrame(start)
    return () => { cancelAnimationFrame(frame) }
  }, [api, open, start])

  return (
    <section
      className={css.panel}
      aria-label={terminalId === 'right' ? 'Right terminal' : 'Terminal'}
      data-desktop-panel={terminalId === 'right' ? 'right-terminal' : 'terminal'}
      data-embedded={embedded || undefined}
      hidden={!open}
    >
      {!embedded && <header className={css.header}>
        <span className={css.title}>Terminal</span>
        <span className={css.status} data-running={running || undefined}>
          {running ? 'Running' : 'Exited'}
        </span>
        {!running && api !== undefined && (
          <button type="button" className={css.restart} onClick={start}>Restart</button>
        )}
      </header>}
      <div ref={hostRef} className={css.terminal} aria-label="Terminal output" />
    </section>
  )
}
