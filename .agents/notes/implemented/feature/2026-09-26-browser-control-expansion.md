# Agent Note: Browser control expansion

Status: implemented

## Problem

The embedded browser needed bounded screenshot variants, coordinate clicks, page-world JavaScript, additional permission coverage, and direct access to completed downloads while preserving existing approval and security boundaries.

## Decision

The browser accepts bounded viewport clips and full-document screenshots, exposes coordinate clicks through the existing CDP input path, and provides an experimental page-world JavaScript tool alongside the existing isolated-world tool. Electron permission requests for geolocation and notifications use the existing approval bridge; device and display-capture permissions remain fail-closed. Download history can open a completed file through the desktop shell. Drag/drop upload and JavaScript prompt handling remain supported. Pointer selection precision is recorded in [Pointer selection precision](../bug-fix/2026-09-26-pointer-selection-precision.md).

## Alternatives considered

**Grant every Electron permission** was rejected because device and display-capture access must remain fail-closed until each surface has an explicit approval contract.

**Expose unrestricted page-world execution** was rejected because the capability stays host-gated and experimental.

**Add active-download cancel/retry controls now** was rejected because the download lifecycle does not yet have a durable operation identity.

## Consequences

Screenshots and coordinate actions cover the new bounded controls without changing the existing tab ownership path. Page-world execution remains opt-in, permissions retain approval checks, and active-download cancel/retry remains deferred. The committed Electron preload must be regenerated whenever the PageAgent patch changes.
