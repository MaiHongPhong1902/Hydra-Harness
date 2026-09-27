import { Motion, type CSSRgbString } from 'ai-motion'

import { isPageDark } from './checkDarkMode'

import styles from './SimulatorMask.module.css'
import cursorStyles from './cursor.module.css'

export class SimulatorMask extends EventTarget {
	shown: boolean = false
	wrapper = document.createElement('div')
	motion: Motion | null = null

	#disposed = false

	#cursor = document.createElement('div')
	#scrollHud: HTMLElement | null = null

	#currentCursorX = 0
	#currentCursorY = 0

	#targetCursorX = 0
	#targetCursorY = 0

	#activeMove: {
		startTime: number
		duration: number
		p0x: number
		p0y: number
		p1x: number
		p1y: number
		p2x: number
		p2y: number
		p3x: number
		p3y: number
		prevX: number
		prevY: number
	} | null = null

	#scrollTimer: ReturnType<typeof setTimeout> | null = null

	constructor() {
		super()

		this.wrapper.id = 'page-agent-runtime_simulator-mask'
		this.wrapper.className = styles.wrapper
		this.wrapper.setAttribute('data-browser-use-ignore', 'true')
		this.wrapper.setAttribute('data-page-agent-ignore', 'true')

		try {
			const isDark = isPageDark()
			const darkColors: [CSSRgbString, CSSRgbString, CSSRgbString, CSSRgbString] = [
				'rgb(56, 189, 248)',  // Sky 400
				'rgb(129, 140, 248)', // Indigo 400
				'rgb(192, 132, 252)', // Soft Violet 400
				'rgb(45, 212, 191)',  // Teal 400
			]
			const lightColors: [CSSRgbString, CSSRgbString, CSSRgbString, CSSRgbString] = [
				'rgb(14, 165, 233)',  // Sky 500
				'rgb(99, 102, 241)',  // Indigo 500
				'rgb(168, 85, 247)',  // Purple 500
				'rgb(20, 184, 166)',  // Teal 500
			]
			const motion = new Motion({
				mode: isDark ? 'dark' : 'light',
				colors: isDark ? darkColors : lightColors,
				borderWidth: 4,
				glowWidth: 160,
				styles: { position: 'absolute', inset: '0' },
			})
			this.motion = motion
			this.wrapper.appendChild(motion.element)
			motion.autoResize(this.wrapper)
		} catch (e) {
			console.warn('[SimulatorMask] Motion overlay unavailable:', e)
		}

		// Capture all mouse, keyboard, and wheel events
		this.wrapper.addEventListener('click', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})
		this.wrapper.addEventListener('mousedown', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})
		this.wrapper.addEventListener('mouseup', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})
		this.wrapper.addEventListener('mousemove', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})
		this.wrapper.addEventListener('wheel', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})
		this.wrapper.addEventListener('keydown', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})
		this.wrapper.addEventListener('keyup', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})

		// Create AI cursor
		this.#createCursor()
		// this.show()

		document.body.appendChild(this.wrapper)

		this.#moveCursorToTarget()

		// global events
		// @note Mask should be isolated from the rest of the code.
		// Global events are easier to manage and cleanup.

		const movePointerToListener = (event: Event) => {
			const detail = ((event as CustomEvent).detail ?? {}) as { x: number; y: number; duration?: number }
			this.setCursorPosition(detail.x, detail.y, detail.duration)
		}
		const clickPointerListener = () => {
			this.triggerClickAnimation()
		}
		const scrollPointerListener = (event: Event) => {
			const detail = ((event as CustomEvent).detail ?? {}) as { deltaX?: number; deltaY?: number; duration?: number }
			this.triggerScrollAnimation(detail)
		}
		const setCursorModeListener = (event: Event) => {
			const detail = ((event as CustomEvent).detail ?? {}) as { mode: 'default' | 'ibeam' | 'pointer' }
			if (detail.mode) this.setCursorMode(detail.mode)
		}
		const selectTextListener = (event: Event) => {
			const detail = ((event as CustomEvent).detail ?? {}) as {
				startX: number
				startY: number
				endX: number
				endY: number
				duration?: number
			}
			void this.animateTextSelection(detail)
		}
		const enablePassThroughListener = () => {
			this.wrapper.style.pointerEvents = 'none'
		}
		const disablePassThroughListener = () => {
			this.wrapper.style.pointerEvents = 'auto'
		}

		window.addEventListener('PageAgent::MovePointerTo', movePointerToListener)
		window.addEventListener('PageAgent::ClickPointer', clickPointerListener)
		window.addEventListener('PageAgent::ScrollPointer', scrollPointerListener)
		window.addEventListener('PageAgent::SetCursorMode', setCursorModeListener)
		window.addEventListener('PageAgent::SelectText', selectTextListener)
		window.addEventListener('PageAgent::EnablePassThrough', enablePassThroughListener)
		window.addEventListener('PageAgent::DisablePassThrough', disablePassThroughListener)

		this.addEventListener('dispose', () => {
			window.removeEventListener('PageAgent::MovePointerTo', movePointerToListener)
			window.removeEventListener('PageAgent::ClickPointer', clickPointerListener)
			window.removeEventListener('PageAgent::ScrollPointer', scrollPointerListener)
			window.removeEventListener('PageAgent::SetCursorMode', setCursorModeListener)
			window.removeEventListener('PageAgent::SelectText', selectTextListener)
			window.removeEventListener('PageAgent::EnablePassThrough', enablePassThroughListener)
			window.removeEventListener('PageAgent::DisablePassThrough', disablePassThroughListener)
		})
	}

	#createCursor() {
		this.#cursor.className = cursorStyles.cursor
		this.#cursor.setAttribute('data-mode', 'default')

		// Create ripple effect container
		const rippleContainer = document.createElement('div')
		rippleContainer.className = cursorStyles.cursorRipple
		this.#cursor.appendChild(rippleContainer)

		// Create filling layer
		const fillingLayer = document.createElement('div')
		fillingLayer.className = cursorStyles.cursorFilling
		this.#cursor.appendChild(fillingLayer)

		// Create border layer
		const borderLayer = document.createElement('div')
		borderLayer.className = cursorStyles.cursorBorder
		this.#cursor.appendChild(borderLayer)

		// Create scroll HUD element attached inside cursor
		this.#createScrollHud()

		this.wrapper.appendChild(this.#cursor)
	}

	#createScrollHud() {
		const hud = document.createElement('div')
		hud.className = cursorStyles.scrollHud ?? 'hydra-scroll-hud'
		hud.setAttribute('data-scroll-hud', 'true')
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
		svg.setAttribute('class', cursorStyles.scrollHudIcon ?? 'hydra-scroll-hud-icon')
		svg.setAttribute('viewBox', '0 0 24 24')
		svg.setAttribute('width', '14')
		svg.setAttribute('height', '14')
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
		path.setAttribute('fill', 'currentColor')
		path.setAttribute('d', 'M12 2C8.69 2 6 4.69 6 8v8c0 3.31 2.69 6 6 6s6-2.69 6-6V8c0-3.31-2.69-6-6-6zm4 14c0 2.21-1.79 4-4 4s-4-1.79-4-4V8c0-2.21 1.79-4 4-4s4 1.79 4 4v8zm-5-9h2v4h-2V7z')
		svg.appendChild(path)
		hud.appendChild(svg)
		this.#cursor.appendChild(hud)
		this.#scrollHud = hud
	}

	#moveCursorToTarget() {
		if (this.#disposed) return

		if (this.#activeMove) {
			const now = performance.now()
			const elapsed = now - this.#activeMove.startTime
			const progress = Math.min(1, Math.max(0, elapsed / this.#activeMove.duration))

			// Natural cubic deceleration
			const u = 1 - Math.pow(1 - progress, 3)
			const u1 = 1 - u

			const curX =
				u1 * u1 * u1 * this.#activeMove.p0x +
				3 * u1 * u1 * u * this.#activeMove.p1x +
				3 * u1 * u * u * this.#activeMove.p2x +
				u * u * u * this.#activeMove.p3x
			const curY =
				u1 * u1 * u1 * this.#activeMove.p0y +
				3 * u1 * u1 * u * this.#activeMove.p1y +
				3 * u1 * u * u * this.#activeMove.p2y +
				u * u * u * this.#activeMove.p3y

			const vx = curX - this.#activeMove.prevX
			const vy = curY - this.#activeMove.prevY
			const speed = Math.hypot(vx, vy)
			this.#activeMove.prevX = curX
			this.#activeMove.prevY = curY

			let tilt = 0
			if (speed > 0.1 && progress < 0.92) {
				const angle = (Math.atan2(vy, vx) * 180) / Math.PI
				tilt = Math.max(-10, Math.min(10, Math.sin(((angle - 45) * Math.PI) / 180) * speed * 0.6))
				tilt *= 1 - progress
			}

			if (progress >= 1) {
				this.#currentCursorX = this.#targetCursorX
				this.#currentCursorY = this.#targetCursorY
				this.#cursor.style.left = `${this.#currentCursorX}px`
				this.#cursor.style.top = `${this.#currentCursorY}px`
				this.#cursor.style.transform = ''
				this.#activeMove = null
			} else {
				this.#currentCursorX = curX
				this.#currentCursorY = curY
				this.#cursor.style.left = `${curX.toFixed(2)}px`
				this.#cursor.style.top = `${curY.toFixed(2)}px`
				this.#cursor.style.transform = Math.abs(tilt) > 0.2 ? `rotate(${tilt.toFixed(1)}deg)` : ''
			}
		} else {
			// Subpixel target consistency
			const dx = this.#targetCursorX - this.#currentCursorX
			const dy = this.#targetCursorY - this.#currentCursorY
			if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
				this.#currentCursorX = this.#targetCursorX
				this.#currentCursorY = this.#targetCursorY
				this.#cursor.style.left = `${this.#currentCursorX}px`
				this.#cursor.style.top = `${this.#currentCursorY}px`
			}
		}

		// Timers continue to advance in hidden Electron views where Chromium may
		// throttle requestAnimationFrame; the cursor remains visible feedback in
		// both headed and headless browser actions.
		setTimeout(() => this.#moveCursorToTarget(), 16)
	}

	setCursorMode(mode: 'default' | 'ibeam' | 'pointer') {
		if (this.#disposed) return
		this.#cursor.setAttribute('data-mode', mode)
		if (mode === 'ibeam') {
			this.#cursor.classList.add(cursorStyles.cursorIbeam ?? 'cursorIbeam')
		} else {
			this.#cursor.classList.remove(cursorStyles.cursorIbeam ?? 'cursorIbeam')
		}
	}

	/** Await the visible move and seal its endpoint even when animation frames are suspended. */
	async moveCursorTo(x: number, y: number) {
		const distance = Math.hypot(x - this.#currentCursorX, y - this.#currentCursorY)
		const duration = Math.min(650, Math.max(160, Math.round(150 + Math.log2(distance + 1) * 40)))
		this.setCursorPosition(x, y, duration)
		await new Promise(resolve => setTimeout(resolve, duration))
		this.setCursorPosition(x, y, 0)
	}

	setCursorPosition(x: number, y: number, duration?: number) {
		if (this.#disposed) return
		if (!Number.isFinite(x) || !Number.isFinite(y)) return

		this.#targetCursorX = x
		this.#targetCursorY = y

		const startX = this.#currentCursorX
		const startY = this.#currentCursorY
		const dist = Math.hypot(x - startX, y - startY)

		if (dist < 0.5 || duration === 0) {
			this.#currentCursorX = x
			this.#currentCursorY = y
			this.#cursor.style.left = `${x}px`
			this.#cursor.style.top = `${y}px`
			this.#cursor.style.transform = ''
			this.#activeMove = null
			return
		}

		// Calculate natural duration if not specified (Fitts's Law approximation)
		const moveDuration = duration ?? Math.min(650, Math.max(160, Math.round(150 + Math.log2(dist + 1) * 40)))

		// Perpendicular normal for subtle natural curved deflection
		const dx = x - startX
		const dy = y - startY
		const nx = -dy / dist
		const ny = dx / dist
		const seed = (startX * 13 + startY * 17) % 100
		const sign = seed > 50 ? 1 : -1
		const deflection = Math.min(32, dist * 0.12) * sign

		this.#activeMove = {
			startTime: performance.now(),
			duration: moveDuration,
			p0x: startX,
			p0y: startY,
			p1x: startX + dx * 0.28 + nx * deflection,
			p1y: startY + dy * 0.28 + ny * deflection,
			p2x: startX + dx * 0.72 + nx * deflection * 0.5,
			p2y: startY + dy * 0.72 + ny * deflection * 0.5,
			p3x: x,
			p3y: y,
			prevX: startX,
			prevY: startY,
		}
	}

	triggerClickAnimation() {
		if (this.#disposed) return

		this.#cursor.classList.remove(cursorStyles.clicking)
		this.#cursor.classList.remove('clicking')
		// Force reflow to restart animation
		this.#cursor.getBoundingClientRect()
		this.#cursor.classList.add(cursorStyles.clicking)
		this.#cursor.classList.add('clicking')
	}

	triggerScrollAnimation(options: { deltaX?: number; deltaY?: number; duration?: number }) {
		if (this.#disposed) return
		const deltaY = options.deltaY ?? 0
		const deltaX = options.deltaX ?? 0

		if (this.#scrollHud) {
			this.#scrollHud.classList.add(cursorStyles.scrollActive ?? 'active')
			this.#scrollHud.classList.add('active')
			const dir = deltaY > 0 ? 'down' : deltaY < 0 ? 'up' : deltaX > 0 ? 'right' : 'left'
			this.#scrollHud.setAttribute('data-direction', dir)

			if (this.#scrollTimer) clearTimeout(this.#scrollTimer)
			this.#scrollTimer = setTimeout(() => {
				this.#scrollHud?.classList.remove(cursorStyles.scrollActive ?? 'active')
				this.#scrollHud?.classList.remove('active')
				this.#scrollTimer = null
			}, 650)
		}

		// Nudge cursor slightly in scroll direction, then spring back
		const nudgeY = deltaY !== 0 ? (deltaY > 0 ? 6 : -6) : 0
		const nudgeX = deltaX !== 0 ? (deltaX > 0 ? 6 : -6) : 0
		const origX = this.#currentCursorX
		const origY = this.#currentCursorY

		const startTime = performance.now()
		const bounceDuration = 320

		const animateBounce = (now: number) => {
			if (this.#disposed) return
			const elapsed = now - startTime
			const p = Math.min(1, elapsed / bounceDuration)
			// Sinusoidal bounce: out and back
			const factor = Math.sin(p * Math.PI)
			const bx = origX + nudgeX * factor
			const by = origY + nudgeY * factor

			if (!this.#activeMove) {
				this.#cursor.style.left = `${bx.toFixed(2)}px`
				this.#cursor.style.top = `${by.toFixed(2)}px`
			}

			if (p < 1) {
				requestAnimationFrame(animateBounce)
			} else if (!this.#activeMove) {
				this.#cursor.style.left = `${origX}px`
				this.#cursor.style.top = `${origY}px`
			}
		}

		requestAnimationFrame(animateBounce)
	}


	/** Resolve after the final selection update, including native input callbacks. */
	async animateTextSelection(options: {
		startX: number
		startY: number
		endX: number
		endY: number
		duration?: number
		updateSelection?: (x: number, y: number) => Promise<unknown>
	}) {
		if (this.#disposed) throw new Error('Selection mask is disposed')
		const { startX, startY, endX, endY, duration = 450, updateSelection } = options
		this.setCursorMode('ibeam')
		await this.moveCursorTo(startX, startY)
		const caretAtPoint = (x: number, y: number) => document.caretRangeFromPoint?.(x, y) ?? null
		const selection = updateSelection ? null : window.getSelection()
		const startRange = selection ? caretAtPoint(startX, startY) : null
		selection?.removeAllRanges()
		const startTime = performance.now()
		for (;;) {
			if (this.#disposed) throw new Error('Selection mask is disposed')
			const progress = duration === 0 ? 1 : Math.min(1, (performance.now() - startTime) / duration)
			const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
			const x = startX + (endX - startX) * ease
			const y = startY + (endY - startY) * ease
			this.#currentCursorX = this.#targetCursorX = x
			this.#currentCursorY = this.#targetCursorY = y
			this.#cursor.style.left = `${x}px`
			this.#cursor.style.top = `${y}px`
			if (updateSelection) await updateSelection(x, y)
			else if (selection && startRange) {
				const caret = caretAtPoint(x, y)
				if (caret) selection.setBaseAndExtent(startRange.startContainer, startRange.startOffset, caret.startContainer, caret.startOffset)
			}
			if (progress === 1) break
			// Timers also advance when Chromium suspends animation frames for an inactive tab.
			await new Promise((resolve) => setTimeout(resolve, 16))
		}
	}

	show() {
		if (this.shown || this.#disposed) return

		this.shown = true
		this.motion?.start()
		this.motion?.fadeIn()

		this.wrapper.classList.add(styles.visible)

		// Initialize cursor position
		this.#currentCursorX = window.innerWidth / 2
		this.#currentCursorY = window.innerHeight / 2
		this.#targetCursorX = this.#currentCursorX
		this.#targetCursorY = this.#currentCursorY
		this.#cursor.style.left = `${this.#currentCursorX}px`
		this.#cursor.style.top = `${this.#currentCursorY}px`
	}

	hide() {
		if (!this.shown || this.#disposed) return

		this.shown = false
		this.motion?.fadeOut()
		this.motion?.pause()

		this.#cursor.classList.remove(cursorStyles.clicking)
		this.#cursor.classList.remove('clicking')

		setTimeout(() => {
			this.wrapper.classList.remove(styles.visible)
		}, 800) // Match the animation duration
	}

	dispose() {
		this.#disposed = true
		if (this.#scrollTimer) clearTimeout(this.#scrollTimer)
		this.motion?.dispose()
		this.wrapper.remove()
		this.dispatchEvent(new Event('dispose'))
	}
}
