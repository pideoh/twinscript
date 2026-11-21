---
paths:
  - "app/**"
  - "native/**"
  - "scripts/build-mac-helper.sh"
---

# Desktop app (Electron)

- The page is untrusted relative to the main process. Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload exposes only the narrow `window.nativeSystemAudio` API; do not widen it without a test in `test/app/desktop.app.js` that pins the exposed surface.
- Files are served from `app://rt/` through the allowlist in `app/policy.js`. A new directory or file type needs an allowlist change and a case in `test/desktop-policy.test.js` (including a traversal attempt).
- Navigation away from `app://rt/` is blocked, `window.open` is denied except for the caption window, and permissions are granted to this origin only. Keep it that way.
- Rules that can be expressed without Electron live in `app/policy.js` and `app/system-audio.js` so they are unit-tested; `app/main.js` stays thin.
- IPC handlers check the caller (`isSystemAudioCaller`): main window, top frame, `app://rt`.
- PC audio on macOS goes through the native helper, not through Electron's loopback capture, which delivers no samples on current macOS (electron/electron#52738). Windows uses Electron's loopback.
- The web app must keep working in a plain browser: code under `src/` may detect Electron but must not depend on it.
- Run `npm run test:app` after changes here. It opens windows and is not part of CI.
