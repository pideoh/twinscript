# 5. Sign macOS builds with a fixed self-signed certificate; ship Windows unsigned for now

- Status: Accepted
- Decided: 2026-11-22
- Changes: #35, #46; issues #22, #23

## Context

macOS ties granted permissions (microphone, system audio recording) to the app's signing identity. Ad-hoc signed builds get a new identity every build, so permissions looked allowed but did not work after an update. An Apple Developer ID and a Windows publisher certificate cost money; SignPath Foundation declined the project's application for free Windows signing.

## Decision

macOS releases and preview builds are re-signed with one project-owned self-signed certificate (`scripts/sign-mac.js`, checked by `scripts/verify-mac-signature.js` and `sign-check.yml`). They are not notarized. Windows builds are not signed. `docs/code-signing-policy.md` states this.

## Consequences

- Permissions survive updates on macOS.
- Both systems warn on first open; the README shows how to proceed. Releases list SHA-256 checksums.
- Automatic updates (#23) wait for Windows signing (#22).
