# Agent Note: Transparent desktop titlebar overlay

Status: implemented

## Problem

The native Windows and Linux titlebar controls kept an opaque shell color while an in-page dialog masked the renderer, leaving the controls area visibly brighter than the rest of the desktop window.

## Decision

The desktop titlebar overlay uses a transparent background on supported platforms. The renderer remains responsible for the titlebar surface, so theme changes and modal masks paint through the native controls area. Native symbol colors still follow the resolved Hydra theme. Desktop layout panel controls move into the titlebar's trailing section, and the titlebar reserves an inset for the native caption controls overlay so renderer controls never overlap native minimize, maximize, and close buttons.

## Alternatives considered

**Recompute a native overlay color for every modal.** Rejected because the main process would need a second modal-state channel and could still diverge from backdrop filtering.

**Exclude the titlebar from modal masks.** Rejected because it leaves the product menu visibly active while a dialog owns focus.

**Position panel controls absolutely below the titlebar.** Rejected because layout controls belong in the top titlebar alongside the sidebar toggle.

## Consequences

The titlebar controls match the renderer in both normal and masked states. The overlay requires the hidden titlebar's full-size renderer content to remain painted beneath the native controls, while the titlebar reserves 144px on the right to keep panel controls clear of the native caption buttons.
