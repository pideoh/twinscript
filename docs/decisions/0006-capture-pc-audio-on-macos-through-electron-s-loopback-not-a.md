# 6. Capture PC audio on macOS through Electron's loopback, not a native helper

- Status: Accepted
- Decided: 2026-11-21
- Changes: #40, #82; issue #24

## Context

The first macOS implementation shipped a native helper binary for system audio. It needed its own build, signing and permission, and was the source of permission problems.

## Decision

PC audio on macOS comes from Electron's loopback audio in the screen-share request the main process answers (`app/policy.js`), with the app's own sound excluded. The helper was removed. This needs macOS 14.2 or later and the System Audio Recording permission only.

## Consequences

- No native code in the repository; `native/` is ignored.
- Older macOS versions cannot capture PC audio.
- Capturing a single app's audio (#30) is not possible this way.
