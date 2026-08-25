# Agent Note: Embedded browser visual automation mask

Status: implemented

## Problem

The controlled browser's indexed actions were visible only through their resulting page state. A user watching a live WorkON flow could not see where BH was about to click or confirm that an action was automated, even though the vendored PageAgent already provides that visual feedback.

## Decision

The Electron preload enables PageController's upstream SimulatorMask, injects its bundled CSS inside the sandboxed document, and keeps PageAgent's Panel absent. The mask and virtual cursor appear around BH-owned indexed click, type, and selection actions; PageAgentCore also uses the same mask for `browser_page_agent_run`. The webpage receives no IPC bridge, model credential, or control surface.

This supersedes only the simulator-mask exclusion in [Embedded browser driven by the harness's own loop](2026-08-22-embedded-browser-page-agent.md); BH still owns the browser control plane and the upstream Panel remains excluded.

## Alternatives considered

**A native Electron overlay.** Rejected because PageAgent already owns the cursor animation and input pass-through behavior; a `WebContentsView` overlay would duplicate it and require separate coordinate and navigation lifecycle handling.

**Enable the mask only for PageAgentCore.** Rejected because normal indexed browser tools are the standard BH evidence path and would remain invisible to a watching user.

## Consequences

The mask is an intentionally visible DOM overlay while an automated indexed action runs, and it temporarily blocks user input to prevent interference. It is recreated per navigation with the preload and fades out after each direct action. Focused real-Electron coverage verifies the panel remains absent, the mask is styled, and its virtual cursor moves for an indexed click.
