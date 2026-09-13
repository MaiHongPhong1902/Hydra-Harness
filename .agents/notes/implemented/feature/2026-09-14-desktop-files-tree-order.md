# Agent Note: Stable ordering in the desktop Files tree

Status: implemented

## Problem

The Files tree depended on provider listing order, so folders and files could move between refreshes and names such as `file10` appeared before `file2`. It also had no direct way to move an entry into an existing folder.

## Decision

Sort each rendered directory with folders first, then case-insensitive natural name order. Add a confined desktop move operation and native drag-and-drop from any tree entry onto a folder. Keep search results in their provider-defined relevance order.

## Alternatives considered

Sorting in the desktop provider would also affect other consumers, while sorting only in the renderer keeps this Files-panel behavior local. Reusing rename with a full destination path would weaken the existing leaf-name validation, so move has its own confined operation.

## Consequences

Workspace navigation stays stable across refreshes and numeric filenames read in the expected order. Dragged entries are moved only inside the registered workspace, collisions and folder self-drops are rejected, and open editor paths follow the move.
