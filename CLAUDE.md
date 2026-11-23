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
| `src/translator.js` | Streaming translation with `gemini-3.5-flash-lite`; `into` fixes the target language, `identify` asks which language a sentence is in (three-language sessions) |
| `src/script-hint.js` | Writing-system hints: which way a transcript is translated (`targetByScript`), which of the selected languages it is in (`sourceByScript`, `languageByScript`), whether a pair can be told apart (`scriptsDiffer`). Pure functions |
| `src/read-aloud.js` | Reads finished translations aloud with the system's speech synthesis: a short queue that drops the oldest waiting sentence, voice choice, language-code mapping. DOM-free, synthesizer injected |
| `src/vocabulary.js` | Parses the "Terms and corrections" setting into recognizer terms (max 1,000) and `wrong => right` rules, and applies the rules to recognized text. Pure functions |
| `src/summarizer.js` | Summary of a finished session (overview, key points, decisions, action items) as structured JSON from the translation model. DOM-free |
| `src/audio.js`, `src/pcm-worklet.js` | Microphone / tab audio capture, 16 kHz PCM in 100 ms chunks, mix for recording |
| `src/auto-gain.js` | Raises quiet PC audio to a usable level (not applied to the microphone). Pure class |
| `src/recorder.js` | Records with MediaRecorder, handing over a chunk every 5 seconds |
| `src/store.js` | IndexedDB: `sessions` (with transcripts) and `audio` (recording chunks). Three-language sessions add `langC` and, per segment, `lang` and `tgts`; `tgt` stays the translations joined by line breaks |
| `src/secrets.js` | Where the API key is kept (desktop: `window.secretStore`; browser: memory only). DOM-free |
| `src/exporter.js` | Transcript export (txt / md / csv / srt). Pure functions |
| `src/mock.js` | Stand-in engines for the `?mock=1` demo |
| `src/i18n.js` | Display-language resolution (`resolveLocale`), `t(key, params)`, applying `data-i18n*` to static HTML. Languages are registered only in its `LOCALES` array |
| `src/locales/*.js` | Message catalogs (`en` is the reference and fallback, `ja`, `zh-Hans`). Dotted keys |
| `src/icons.js` | Octicons (SVG) for buttons that are created at runtime |
| `src/message-error.js` | Error carrying a message key and params; thrown by `audio.js`, `transcriber.js`, `translator.js` and translated by `app.js` |
| `app/main.js` | Electron main process: serves the app from `app://rt/`, PC audio, caption overlay |
| `app/policy.js` | Desktop rules (served files, navigation, `window.open`, permissions, IPC caller check, what a screen-share request gets per platform). Electron-free |
| `app/preload.js` | The page's only bridge to the main process: `window.secretStore`, `window.captionOverlay` (click-through) and `window.appShortcuts` (global shortcuts) |
| `app/shortcuts.js` | Global shortcut table, platform labels and registration status. Electron-free |
| `app/secrets.js` | Desktop secret store: `safeStorage` ciphertext in `userData/secrets.json`, allowlisted names. Electron-free |
| `test/*.test.js` | Unit tests (`node:test`, no dependencies) |
| `test/e2e/*.e2e.js`, `test/e2e/helpers.js` | Browser tests: Chrome, a fake microphone and mocked Gemini endpoints. Split into files by topic so they run in parallel; shared setup is in `helpers.js`. `a11y.e2e.js` runs axe-core on the main screen and dialogs in both themes |
| `test/app/desktop.app.js` | Desktop smoke tests (need a display, so not run in CI) |
| `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json` | release-please keeps a release pull request open on `main`; merging it tags `vX.Y.Z`, creates the GitHub Release, and the workflow builds and uploads the zips |
| `scripts/check-commits.js` | Checks that a pull request's commit subjects and title follow Conventional Commits (run in `test.yml`) |
| `scripts/sign-mac.js`, `scripts/verify-mac-signature.js`, `scripts/ci-mac-signing-keychain.sh` | macOS releases are re-signed with a fixed self-signed certificate (electron-builder `afterSign` hook) so the app's identity, and the permissions tied to it, survive updates; the check and the CI keychain setup. `.github/workflows/sign-check.yml` exercises this on pull requests |

## Commands

- `npm run lint`: Biome checks formatting and lint rules; `npm run format` applies the fixes. Run before committing.
- `npm test`: unit tests. Run after every logic change.
- `npm run test:e2e`: only when `src/app.js`, `src/audio.js`, HTML or CSS changed.
- `npm start`: http://localhost:5173 (`?mock=1` for a demo without a key, `?debug=1` to log raw recognizer output).
- `npm run app`: start the desktop app. `npm run test:app` only when `app/` or the caption window changed.
- `npm run dist:mac` / `npm run dist:win`: build zips into `dist/`.

## Rules

- A change that users can see updates the docs in the same pull request: the README (both languages) and pages under `docs/` that describe it, and the README animation when the main screen looks different (`node scripts/demo.mjs` writes `docs/demo.png`). Do not regenerate the animation otherwise: each version adds several megabytes to the repository.
- Add or update tests in the same commit as a behavior change. For a segmentation bug, add the failing case to `test/segmenter.test.js` before fixing it.
- No new dependencies: zero at runtime; dev dependencies are `playwright-core`, `electron`, `electron-builder`, `@biomejs/biome` and `axe-core` only.
- The interface must keep running in a plain browser (development and the browser tests rely on it). Desktop-only code lives in `app/`; `src/` only branches on detecting Electron.
- Some assumptions about the Gemini Live API are unverified against the real service (interim text is the whole utterance so far; one final result per utterance). Check the official documentation instead of guessing when a change depends on API behavior.
- User-visible text goes through i18n (`t()` or `data-i18n*`; modules without UI throw `MessageError` with a message key). Add every new key to all files in `src/locales/` with the same placeholders; `test/i18n.test.js` checks this.
- Code, comments and commit messages are in English.
- Commit subjects and pull request titles follow Conventional Commits, `type(scope)!: description`, with the types feat, fix, perf, revert, docs, test, build, ci, chore, refactor, style; `scripts/check-commits.js` enforces this on pull requests.

## Design

- The visual reference is GitHub Primer (https://primer.style/product/). Components follow Primer's anatomy and sizes (Button / IconButton / Select / TextInput / Dialog / NavList / Banner / Label).
- Tokens live only in the block at the top of `styles.css` (copied from `@primer/primitives` under Primer's token names; the version is in the comment there). All other CSS refers to them with `var(--…)`: no literal colors, spacing, radii or font sizes. The one exception is the translucent backdrop of the caption overlay.
- Icons are 16px Octicons embedded as SVG (`aria-hidden="true"`, `fill="currentColor"`, with a translated `aria-label` on the button). Icons created at runtime come from `src/icons.js`. Do not use Unicode symbols as icons.
- When you add a component or token from Primer, keep the versions in `THIRD-PARTY-NOTICES.md` in step.

## Releases

Releases go through a release pull request. On every push to `main`, release-please
(`.github/workflows/release.yml`) opens or updates the pull request `chore(main): release X.Y.Z`, which sets the
version in `package.json` and updates `CHANGELOG.md` from the Conventional Commits since the last release.
Merging it tags `vX.Y.Z`, creates the GitHub Release, and builds and uploads the zips. `feat` releases a minor
version; `fix`, `perf` and `revert` a patch; a breaking change (`type!:` or a `BREAKING CHANGE:` footer) a major.
`docs`, `test`, `build`, `ci`, `chore`, `refactor` and `style` do not release on their own; dependency updates
(`chore(deps)`) ship with the next release, or as `fix(deps): …` to release one on its own. Never edit `version`
in `package.json` or the manifest by hand. The table is in CONTRIBUTING.md.
