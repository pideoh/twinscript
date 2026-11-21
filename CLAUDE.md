# Twinscript

A desktop app for macOS and Windows: real-time transcription and two-way translation for meetings.
It is built with web technology (plain HTML, CSS and ES modules, no build step, no server) and
packaged with Electron; the app talks to the Gemini API directly. The same interface also runs in a
browser, which is used for development and the browser tests. Usage and pricing are in README.md; contribution rules are in CONTRIBUTING.md.

## Layout

| File | Role |
| --- | --- |
| `src/app.js` | UI, settings, saved sessions (list / switch), start / stop, translation flow, downloads |
| `src/segmenter.js` | Turns recognizer results (interim / final) into sentence-sized segments. DOM-free |
| `src/transcriber.js` | Gemini Live API (`gemini-3.5-transcribe-live`) WebSocket, reconnects, rotation before the 10-minute session limit |
| `src/translator.js` | Streaming translation with `gemini-3.5-flash-lite` |
| `src/audio.js`, `src/pcm-worklet.js` | Microphone / tab audio capture, 16 kHz PCM in 100 ms chunks, mix for recording |
| `src/auto-gain.js` | Raises quiet PC audio to a usable level (not applied to the microphone). Pure class |
| `src/recorder.js` | Records with MediaRecorder, handing over a chunk every 5 seconds |
| `src/store.js` | IndexedDB: `sessions` (with transcripts) and `audio` (recording chunks) |
| `src/exporter.js` | Transcript export (txt / md / csv / srt). Pure functions |
| `src/mock.js` | Stand-in engines for the `?mock=1` demo |
| `src/i18n.js` | Display-language resolution (`resolveLocale`), `t(key, params)`, applying `data-i18n*` to static HTML. Languages are registered only in its `LOCALES` array |
| `src/locales/*.js` | Message catalogs (`en` is the reference and fallback, `ja`, `zh-Hans`). Dotted keys |
| `src/icons.js` | Octicons (SVG) for buttons that are created at runtime |
| `src/message-error.js` | Error carrying a message key and params; thrown by `audio.js`, `transcriber.js`, `translator.js` and translated by `app.js` |
| `app/main.js` | Electron main process: serves the app from `app://rt/`, PC audio, caption overlay |
| `app/policy.js` | Desktop rules (served files, navigation, `window.open`, permissions). Electron-free |
| `app/preload.js` | macOS only: exposes the PC audio helper to the page as `window.nativeSystemAudio` |
| `app/system-audio.js` | PC audio helper rules (location, caller check, exit reasons, sample framing). Electron-free |
| `native/mac/system-audio.swift`, `scripts/build-mac-helper.sh` | macOS PC audio helper (ScreenCaptureKit, 48 kHz mono Float32 on stdout) and its build, output in `native/mac/build/` |
| `test/*.test.js` | Unit tests (`node:test`, no dependencies) |
| `test/e2e/*.e2e.js`, `test/e2e/helpers.js` | Browser tests: Chrome, a fake microphone and mocked Gemini endpoints. Split into files by topic so they run in parallel; shared setup is in `helpers.js` |
| `test/app/desktop.app.js` | Desktop smoke tests (need a display, so not run in CI) |
| `.github/workflows/release.yml`, `scripts/next-version.js` | Build the zips, pick the next version and publish a GitHub Release when the app changes on `main` |

## Commands

- `npm test`: unit tests. Run after every logic change.
- `npm run test:e2e`: only when `src/app.js`, `src/audio.js`, HTML or CSS changed.
- `npm start`: http://localhost:5173 (`?mock=1` for a demo without a key, `?debug=1` to log raw recognizer output).
- `npm run app`: start the desktop app. `npm run test:app` only when `app/` or the caption window changed.
- `npm run dist:mac` / `npm run dist:win`: build zips into `dist/` (`dist:mac`, and `npm run app` on macOS, also build the Swift helper).

## Rules

- Add or update tests in the same commit as a behavior change. For a segmentation bug, add the failing case to `test/segmenter.test.js` before fixing it.
- No new dependencies: zero at runtime; dev dependencies are `playwright-core`, `electron` and `electron-builder` only.
- The interface must keep running in a plain browser (development and the browser tests rely on it). Desktop-only code lives in `app/`; `src/` only branches on detecting Electron.
- Some assumptions about the Gemini Live API are unverified against the real service (interim text is the whole utterance so far; one final result per utterance). Check the official documentation instead of guessing when a change depends on API behavior.
- User-visible text goes through i18n (`t()` or `data-i18n*`; modules without UI throw `MessageError` with a message key). Add every new key to all files in `src/locales/` with the same placeholders; `test/i18n.test.js` checks this.
- Code, comments and commit messages are in English.

## Design

- The visual reference is GitHub Primer (https://primer.style/product/). Components follow Primer's anatomy and sizes (Button / IconButton / Select / TextInput / Dialog / NavList / Banner / Label).
- Tokens live only in the block at the top of `styles.css` (copied from `@primer/primitives` under Primer's token names; the version is in the comment there). All other CSS refers to them with `var(--…)`: no literal colors, spacing, radii or font sizes. The one exception is the translucent backdrop of the caption overlay.
- Icons are 16px Octicons embedded as SVG (`aria-hidden="true"`, `fill="currentColor"`, with a translated `aria-label` on the button). Icons created at runtime come from `src/icons.js`. Do not use Unicode symbols as icons.
- When you add a component or token from Primer, keep the versions in `THIRD-PARTY-NOTICES.md` in step.

## Releases

Any change to the app on `main` (`app/`, `src/`, `native/`, `icons/`, `index.html`, `styles.css`,
`package.json`) is built and published automatically. The version bump comes
from the commit subjects since the last release; the table is in CONTRIBUTING.md. In short: start a
subject with `Add` or `feat` only for a new feature, never bump `version` in `package.json` by hand,
and mark breaking changes with `BREAKING CHANGE` in the body.
