// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DesktopTitleBar } from '@hydra/harness-client-ui-layout/src/client/DesktopTitleBar.tsx'

afterEach(cleanup)

describe('DesktopTitleBar', () => {
  it('opens product menus and routes controls to stable actions', () => {
    const onAction = vi.fn()
    render(<DesktopTitleBar onAction={onAction} sidebarOpen />)

    fireEvent.click(screen.getByRole('button', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /New Chat/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true })

    expect(onAction).toHaveBeenNthCalledWith(1, 'new-chat')
    expect(onAction).toHaveBeenNthCalledWith(2, 'toggle-sidebar')
    expect(onAction).toHaveBeenNthCalledWith(3, 'toggle-bottom-panel')
  })
})
