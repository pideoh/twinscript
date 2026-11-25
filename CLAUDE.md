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
| `src/transcriber.js` | Gemini Live API (`gemini-3.5-transcribe-live`) WebSocket, reconnects, rotation before the 10-minute session limit; each connection uses a single-use token from `auth_tokens` (the key travels in a request header only), falling back to the key in the address when the token service never answers |
| `src/translator.js` | Streaming translation with `gemini-3.5-flash-lite`; `into` fixes the target language, `identify` asks which language a sentence is in (three-language sessions) |
| `src/script-hint.js` | Writing-system hints: which way a transcript is translated (`targetByScript`), which of the selected languages it is in (`sourceByScript`, `languageByScript`), whether a pair can be told apart (`scriptsDiffer`). Pure functions |
| `src/read-aloud.js` | Reads finished translations aloud with the system's speech synthesis: a short queue that drops the oldest waiting sentence, voice choice, language-code mapping. DOM-free, synthesizer injected |
| `src/vocabulary.js` | Parses the "Terms and corrections" setting into recognizer terms (max 1,000) and `wrong => right` rules, and applies the rules to recognized text. Pure functions |
| `src/summarizer.js` | Summary of a finished session as Markdown, written to a template, a length and a language by the translation model; `legacySummaryToMarkdown` shows summaries made by earlier versions. DOM-free |
| `src/summary-templates.js` | The eight preset templates (`{ id, name, description, prompt }`) and custom ones: validation, import / export, storage in `localStorage` under `rt-summary-templates` |
| `src/speakers.js` | Speaker labels, pure logic: planning the parts of a recording, choosing reference clips, mapping each part's labels to the session's speakers (with the safeguards that leave a speaker unknown rather than guess), assigning speakers to segments, WAV bytes |
| `src/diarizer.js` | Requests to the Files and Interactions APIs for `gemini-3.5-transcribe` with diarization and word times, and the loop over the parts (`labelSpeakers`). DOM-free |
| `src/speaker-audio.js` | Decodes a session's recordings with Web Audio into 16 kHz mono samples |
| `src/markdown.js` | Safe Markdown renderer for summaries (headings, lists, tables, emphasis, code, http/https links); everything else, raw HTML included, is shown as text. DOM-free |
| `src/audio.js`, `src/pcm-worklet.js` | Microphone / tab audio capture, 16 kHz PCM in 100 ms chunks, mix for recording |
| `src/auto-gain.js` | Raises quiet PC audio to a usable level (not applied to the microphone). Pure class |
| `src/recorder.js` | Records with MediaRecorder, handing over a chunk every 5 seconds |
| `src/store.js` | IndexedDB, version 3: `sessions` (metadata and `segmentCount`, no segments), `segments` (one record per segment, key `[sessionId, pos]`, loaded when a session is opened; a save writes only changed segments), `summaries` (one record per summary, key `[sessionId, id]`) and `audio` (recording chunks). The upgrade from version 1 moves segments out of the session records. Three-language sessions add `langC` and, per segment, `lang` and `tgts`; `tgt` stays the translations joined by line breaks. A session's metadata carries its `usage` record; segments may carry `speaker`, and the metadata `speakerLabels` |
| `src/secrets.js` | Where the API key is kept (desktop: `window.secretStore`; browser: memory only). DOM-free |
| `src/exporter.js` | Transcript export (txt / md / csv / srt). Pure functions |
| `src/mock.js` | Stand-in engines for the `?mock=1` demo |
| `src/pacer.js` | When the sentence being spoken is translated: pacing strategies `interval`, `steady`, `carry` (each request continues the translation on screen), `chunk` and `settle` (the app's default: `carry`, and a finished sentence keeps a shown translation that already covers it); `?debug=1&pacer=<name>` selects one. DOM-free, clock and timers injected |
| `src/trace.js` | Debug-only (`?debug=1`) trace of raw recognizer results with times; JSON format v1 and the download file name. DOM-free |
| `src/debug-tools.js` | Debug-only tools wired into `app.js`: the "Audio file (debug)" input and file picker, the trace download entry |
| `src/i18n.js` | Display-language resolution (`resolveLocale`), `t(key, params)`, applying `data-i18n*` to static HTML. Languages are registered only in its `LOCALES` array |
| `src/locales/*.js` | Message catalogs (`en` is the reference and fallback, `ja`, `zh-Hans`). Dotted keys |
| `src/icons.js` | Octicons (SVG) for buttons that are created at runtime |
| `src/message-error.js` | Error carrying a message key and params; thrown by `audio.js`, `transcriber.js`, `translator.js`, `diarizer.js` and translated by `app.js` |
| `app/main.js` | Electron main process: serves the app from `app://rt/`, PC audio, caption overlay |
| `app/policy.js` | Desktop rules (served files, navigation, `window.open`, permissions, IPC caller check, what a screen-share request gets per platform). Electron-free |
| `app/preload.js` | The page's only bridge to the main process: `window.secretStore`, `window.captionOverlay` (click-through) and `window.appShortcuts` (global shortcuts) |
| `app/shortcuts.js` | Global shortcut table, platform labels and registration status. Electron-free |
| `app/secrets.js` | Desktop secret store: `safeStorage` ciphertext in `userData/secrets.json`, allowlisted names. Electron-free |
| `test/*.test.js` | Unit tests (`node:test`, no dependencies) |
| `test/e2e/*.e2e.js`, `test/e2e/helpers.js`, `test/e2e/helpers/*.js` | Browser tests: Chrome, a fake microphone and mocked Gemini endpoints. One file per topic so they run in parallel (`api-key`, `language`, `shell`, `capture` for the microphone, `pc-audio`, `live-token`, `vocabulary`, `sessions`, `summary`, `speakers`, `usage`, `a11y`, ...). Shared setup lives in `helpers/` by topic (`app.js`: server, `openApp`, `listening`; `gemini.js`: Gemini mocks; `speakers.js`, `summary.js`, `storage.js`, `targets.js`, `pc-audio.js`); `helpers.js` only re-exports them, and tests import from `./helpers.js` |
| `test/app/desktop.app.js` | Desktop smoke tests (need a display, so not run in CI) |
| `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json` | release-please keeps a release pull request open on `main`; merging it tags `vX.Y.Z`, creates the GitHub Release, and the workflow builds and uploads the zips |
| `.github/workflows/preview-build.yml` | Started by hand: builds signed zips of a branch as workflow artifacts, to try the app before a release. Publishes nothing |
| `scripts/check-commits.js` | Checks that a pull request's commit subjects and title follow Conventional Commits (run in `test.yml`) |
| `src/pricing.js` | Gemini price table (paid tier, Standard; the block is rewritten by `scripts/update-pricing.mjs`), cost of a usage record, price overrides, USD formatting. Pure, DOM-free |
| `src/usage.js` | Versioned usage record (listening time; requests and tokens from `usageMetadata`, thinking counted as output) and its arithmetic. Pure, DOM-free |
| `src/usage-stats.js` | Daily usage totals in `localStorage` (`rt-usage`, kept when sessions are deleted) and the rows of the usage dialog. Pure. `LIVE_MODEL` must follow `MODEL` in `src/transcriber.js` (a unit test checks it) |
| `scripts/update-pricing.mjs`, `.github/workflows/pricing-check.yml` | Check the price table against Google's pricing page (`--write` to update); the monthly workflow proposes changes as a pull request |
| `scripts/record-metrics.mjs`, `.github/workflows/metrics.yml` | Weekly record of views, clones, referrers, stars and release downloads as CSV files on the `metrics` branch (GitHub keeps traffic for 14 days). Needs the secret `METRICS_TOKEN` |
| `scripts/tuning/replay.mjs`, `scripts/tuning/metrics.mjs`, `scripts/tuning/clock.mjs` | Replays a recognizer trace through the segmenter, the pacer and the translator (real, or `--mock` on a simulated clock) and scores first / final delay, flicker and requests. See `docs/tuning.md` |
| `scripts/tuning/latency.mjs` | Times one short translation request with the app's request options and alternatives, and reports thinking tokens: tells a slow model from a slow strategy |
| `scripts/sign-mac.js`, `scripts/verify-mac-signature.js`, `scripts/ci-mac-signing-keychain.sh` | macOS releases are re-signed with a fixed self-signed certificate (electron-builder `afterSign` hook) so the app's identity, and the permissions tied to it, survive updates; the check and the CI keychain setup. `.github/workflows/sign-check.yml` exercises this on pull requests |

## Commands

- `npm run lint`: Biome checks formatting and lint rules; `npm run format` applies the fixes. Run before committing.
- `npm test`: unit tests. Run after every logic change.
- `npm run test:e2e`: only when `src/app.js`, `src/audio.js`, HTML or CSS changed.
- `npm start`: http://localhost:5173 (`?mock=1` for a demo without a key, `?debug=1` to log raw recognizer output, download a recognizer trace and use an audio file as input; see `docs/tuning.md`).
- `npm run app`: start the desktop app. `npm run test:app` only when `app/` or the caption window changed.
- `npm run dist:mac` / `npm run dist:win`: build zips into `dist/`.

## Rules

- A change to the tuning tools (`?debug=1`, `scripts/tuning/`, the trace format, the pacer's strategies) updates `docs/tuning.md` in the same pull request.
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
