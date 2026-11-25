# 3. GitHub Primer as the visual reference

- Status: Accepted
- Decided: 2026-11-21
- Changes: #2, #45

## Context

The interface needed one consistent, accessible design language that a single maintainer can apply without designing a system.

## Decision

Components follow Primer's anatomy and sizes. Tokens are copied from `@primer/primitives` into one block at the top of `styles.css` and all other CSS refers to them. Icons are 16px Octicons embedded as SVG. axe-core checks the main screen and the dialogs in both themes.

## Consequences

- No literal colors, spacing, radii or font sizes outside the token block (the caption overlay's translucent backdrop is the one exception).
- Versions of what was copied are tracked in `THIRD-PARTY-NOTICES.md`.
