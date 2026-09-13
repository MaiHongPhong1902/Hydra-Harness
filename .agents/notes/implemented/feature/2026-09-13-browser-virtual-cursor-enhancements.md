# Agent Note: Browser virtual cursor animation subsystems and coordinate precision

Status: implemented

## Problem

The embedded browser simulator mask rendered an AI cursor with a basic linear frame interpolation, lacked visual cues for scrolling and clicking squash/bounce dynamics, and did not reflect actual text selections. Furthermore, cursor coordinates and reference frames required subpixel precision and exact hotspot alignment across arrow and text selection modes.

## Decision

The virtual pointer engine in `@hydra/harness-browser-electron` implements four dedicated animation subsystems and subpixel coordinate invariants:

1. **Move trajectory**: Native Playwright actions await the preload's shared `prepare_pointer` path so clicks, hover, typing, and field fills update the virtual cursor. Time-based cubic Bézier interpolation ($N=4$) with natural deflection arc. Movement duration is calculated dynamically via Fitts's law approximation ($150 + 40 \log_2(d + 1)\text{ ms}$). Velocity banking rotates the cursor subtly along the movement tangent ($\pm 10^\circ$), damping to zero before arrival. Subpixel arrival snaps to exact target coordinates when remaining distance is under $0.5\text{px}$.
2. **Three-phase click**: The cursor filling layer animates a $0.82\times$ squash anchored at the arrow tip (`transform-origin: 29px 15px`), accompanied by a dual-tone expanding shockwave ripple ($0.2\times \to 2.4\times$) and elastic recovery bounce ($1.08\times \to 1.0\times$).
3. **Scroll animation**: Scrolling dispatches `PageAgent::ScrollPointer`, triggering a transient wheel HUD pill displaying scroll direction (`up`, `down`, `left`, `right`) that fades out after 650ms, alongside a sinusoidal inertia float ($\pm 6\text{px}$) that springs back smoothly.
4. **DOM text selection**: Text selection is backed by the browser's DOM Selection API. Selection ranges compute caret coordinates via `caretRangeFromPoint` and mutate the document's active selection via `selection.setBaseAndExtent`, letting Chromium emit `selectionchange` events and enabling clipboard operations. Named input and textarea targets use their native selection ranges; named element targets select their complete DOM contents. Coordinate drags inside inputs and textareas use native Chromium mouse events and return the selected value slice. The action awaits the animation and its final native selection update before reporting text; current and target cursor coordinates advance together. Timer-driven progress also completes when inactive tabs suspend animation frames. The cursor morphs into a centered I-beam icon (`data-mode="ibeam"`) with crossbar hotspot at $(12, 12)$ during text selection and typing.
5. **Coordinate accuracy**: Hotspot offsets are normalized at $(0, 0)$ across modes: arrow tip translates by $(-29\text{px}, -15\text{px})$ and I-beam crossbar translates by $(-12\text{px}, -12\text{px})$. DOM hierarchy preserves `#page-agent-runtime_simulator-mask` and ensures the cursor remains `mask.lastElementChild`.

## Alternatives considered

**Visual-only text highlight overlay.** Drawing an absolute rectangle overlay simulates selection visually but fails to register with `window.getSelection()`, breaking native copy/paste, screen readers, and page event listeners. Real DOM ranges guarantee functional parity.

**CSS transitions for cursor movement.** CSS `transition: left, top` cannot dynamically adjust control points or calculate instantaneous velocity banking angles mid-flight. Frame-based Bézier interpolation provides direct access to velocity vectors.

## Consequences

Automated actions in the browser view present realistic human-like pointer interactions. Real text selection highlights actual text in the page, verifiable through `window.getSelection()`. Existing test assertions targeting mask presence, `mask.lastElementChild`, and `cursor.style.left` remain satisfied.

The tool result schema declares `action.selectedText`; the assembled `browser-tool-turn` snapshot executes selection through the real tool runtime to catch output-validation failures.

The parent repository tracks the upstream cursor changes in `page-agent.patch`; preload builds apply it to the pinned submodule or verify it is already applied. Conflicting source changes fail the build.

Real Electron tests in `electron.spec.ts` measure multiple intermediate cursor positions and final element-center coordinates for native hover, click, and typing. They also cover scroll HUD direction rendering, virtual cursor style CSP resilience, native cursor coexistence, complete multiline selection, partial DOM/input/textarea ranges, reverse drags, empty and unsupported inputs, and stable cursor endpoints.

## Deferred work

Custom SVG skins per agent persona, multi-touch gesture trails, and right-to-left vertical text selection cursors remain deferred.
