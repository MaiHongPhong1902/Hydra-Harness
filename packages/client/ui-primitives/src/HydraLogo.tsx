/** Shared Hydra artwork for product branding. */
import { useState } from 'react'
import clsx from 'clsx'
import { hydraLogoData } from './hydra-logo-data.ts'
import { hydraHoverData } from './hydra-hover-data.ts'
import type { IconProps } from './icons/props.ts'
import css from './HydraLogo.module.css'

/**
 * Render the supplied Hydra artwork, playing only while the pointer hovers over it.
 * @param props.size - Square size in pixels; defaults to 24.
 * @param props.className - Optional layout class.
 * @returns The logo SVG with its image hrefs.
 */
export function HydraLogo({ size = 24, className }: IconProps) {
  const [playing, setPlaying] = useState(false)
  return (
    <svg
      width={size}
      height={size}
      className={clsx(playing && css.playing, className)}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      onMouseEnter={() => { setPlaying(true) }}
      onMouseLeave={() => { setPlaying(false) }}
    >
      <image className={css.still} width="256" height="256" href={hydraLogoData} />
      {playing && <image className={css.motion} width="256" height="256" href={hydraHoverData} />}
    </svg>
  )
}
