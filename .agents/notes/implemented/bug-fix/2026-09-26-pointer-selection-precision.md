# Agent Note: Pointer and text-selection precision

Status: implemented

## Problem

Coordinate selection in text inputs could include the blank after a word, and the visible caret could remain at the raw drag endpoint. DOM selection could also sample its start caret before the animated pointer reached the requested coordinate.

## Decision

Native input selections trim a trailing blank when the selected content is a single word and move the virtual caret to the measured selection boundary. DOM selections wait for the cursor move to finish before resolving the start caret and use the same caret-range lookup for every endpoint.

## Alternatives considered

**Return the raw Chromium selection** was rejected because replacing one word could also remove its following blank and leave the visible caret misleadingly offset.

**Replace native input events with synthetic DOM selection** was rejected because Chromium's native mouse path remains the reliable way to select input and textarea values.

**Use a fixed delay before reading the DOM caret** was rejected because the cursor movement duration varies with distance and can exceed the delay.

## Consequences

Word edits keep the adjacent blank and the visible caret follows the adjusted endpoint. Longer or multiword selections keep their native behavior; textarea caret repositioning remains limited to the selection value because multiline geometry needs a separate layout calculation.
