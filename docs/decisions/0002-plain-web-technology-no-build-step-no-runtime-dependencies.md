# 2. Plain web technology: no build step, no runtime dependencies

- Status: Accepted
- Decided: 2026-11-21
- Changes: #12, #13, #45

## Context

The app is small, and a toolchain or third-party code at runtime would add supply-chain risk and upkeep to software that handles an API key and meeting audio.

## Decision

The interface is plain HTML, CSS and ES modules, served as files. There are zero runtime dependencies. Development dependencies are limited to `playwright-core`, `electron`, `electron-builder`, `@biomejs/biome` and `axe-core`; unit tests use `node:test`.

## Consequences

- What is in the repository is what runs; nothing is transpiled or bundled.
- Things a library would give (a Markdown renderer, IndexedDB helpers, i18n) are written here, kept small and tested.
- Dependabot merges only minor and patch updates of the tools on its own.
