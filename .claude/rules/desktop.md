---
paths:
  - "app/**"
---

# Desktop app (Electron)

- The page is untrusted relative to the main process. Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload exposes only narrow APIs: `window.secretStore` (get / set of allowlisted secrets), `window.captionOverlay` (click-through) and `window.appShortcuts` (global shortcuts); do not widen it without a test in `test/app/desktop.app.js` that pins the exposed surface.
- Files are served from `app://rt/` through the allowlist in `app/policy.js`. A new directory or file type needs an allowlist change and a case in `test/desktop-policy.test.js` (including a traversal attempt).
- Navigation away from `app://rt/` is blocked, `window.open` is denied except for the caption window, and permissions are granted to this origin only. Keep it that way.
- Rules that can be expressed without Electron live in `app/policy.js`, `app/secrets.js` and `app/shortcuts.js` so they are unit-tested; `app/main.js` stays thin.
- IPC handlers check the caller (`isAppCaller`): main window, top frame, `app://rt`.
- PC audio uses Electron's loopback capture on both platforms. On macOS the video of the answer is the requesting frame, so only the System Audio Recording permission is needed (macOS 14.2 or later); do not use `useSystemPicker`.
- The interface must keep working in a plain browser, which development and the browser tests rely on: code under `src/` may detect Electron but must not depend on it.
- Run `npm run test:app` after changes here. It opens windows and is not part of CI.
