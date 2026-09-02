import type { ButtonHTMLAttributes } from 'react'
import css from './Switch.module.css'

/** Accessible two-state control for immediate boolean settings. */
export function Switch({ checked, ...props }: {
  checked: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'aria-checked'>) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={css.switch}
      data-checked={checked || undefined}
    >
      <span className={css.thumb} />
    </button>
  )
}
