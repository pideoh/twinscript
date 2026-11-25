# 4. Keep the API key in OS-protected storage, and ask the system only when there is a key

- Status: Accepted
- Decided: 2026-11-21
- Changes: #14, #41

## Context

The key is the only secret the app holds. Code scanning flagged keeping it in page storage, and on macOS reading it at startup opened the Keychain and could prompt before the user had done anything.

## Decision

On the desktop the key is encrypted with Electron's `safeStorage` and stored as ciphertext in `userData/secrets.json`, reached from the page only through `window.secretStore`. In a browser it is kept in memory only. The file is read before the system is asked whether encryption is available, so the Keychain is touched only when a key exists or is being saved.

## Consequences

- The key never sits in `localStorage` or IndexedDB.
- A browser session asks for the key again after a reload.
- macOS shows a Keychain item for the app, which the README explains.
