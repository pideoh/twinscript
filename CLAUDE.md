# Twinscript

A desktop app for macOS and Windows: real-time transcription and two-way translation for meetings.
It is built with web technology (plain HTML, CSS and ES modules, no build step, no server) and
packaged with Electron; the app talks to the Gemini API directly. The same interface also runs in a
browser, which is used for development and the browser tests. Usage and pricing are in README.md; contribution rules are in CONTRIBUTING.md.

## Principles

@docs/principles.md

## Map

| Where | What |
| --- | --- |
| `index.html`, `styles.css` | The page and its styles (Primer tokens in the block at the top of `styles.css`) |
| `src/app.js` | The entry: wires the parts together (startup, start and stop, opening a session). It does not grow |
| `src/speech/` | Capture, recognition (Gemini Live), segmentation into sentences, vocabulary |
| `src/translation/` | Translation, when the sentence in progress is translated (pacing), script hints, reading aloud |
| `src/session/` | After a meeting: summaries and templates, speaker labels, Markdown, export |
| `src/storage/` | IndexedDB (sessions, segments, summaries, audio), settings, the API key |
| `src/usage/` | Usage records, the price table, daily totals |
| `src/ui/` | Parts of the screen, i18n and message catalogs (`locales/`), icons, languages offered |
| `src/debug/` | Recognizer trace, debug tools, the engines of the `?mock=1` demo |
| `app/` | The desktop app (Electron): main process, preload bridge, and the rules that need no Electron (`policy`, `secrets`, `shortcuts`, `updates`) |
| `scripts/` | Tools: commit check, price update, metrics, macOS signing, what the browser tests cover (`e2e-coverage.mjs`), `tuning/` (replay and latency) |
| `test/` | `unit/{src,app,scripts,rules}/`, `e2e/`, `desktop/`; see `test/README.md` |
| `docs/` | Principles, tuning, API key guide, signing policy, the README's pictures |
| `.github/workflows/` | Tests, release (release-please), preview build, price check, metrics, signing check |

Every source file starts with a comment that says what it is for and what is not obvious about it. Read that
comment rather than expecting a description here, and keep it true when the file changes.

## Commands

- `npm run lint`: Biome checks formatting and lint rules; `npm run format` applies the fixes. Run before committing.
- `npm test`: unit tests. Run after every logic change.
- `npm run test:e2e`: only when `src/app.js`, `src/speech/audio.js`, HTML or CSS changed.
- `npm run test:e2e:desktop`: the same browser tests against the desktop app (opens windows; CI runs it on macOS and Windows).
- `npm run test:e2e:coverage`: the browser tests, then a table of what they cover in `src/` (line % per file, uncovered ranges).
- `npm start`: http://localhost:5173 (`?mock=1` for a demo without a key, `?debug=1` to log raw recognizer output, download a recognizer trace and use an audio file as input; see `docs/tuning.md`).
- `npm run app`: start the desktop app. `npm run test:app` only when `app/` or the caption window changed.
- `npm run dist:mac` / `npm run dist:win`: build zips into `dist/`.

## Where the rules are

Each rule is written once. Open the file for what you are about to touch.

| Topic | File | Loaded |
| --- | --- | --- |
| The order of work: issue, branch, checks, pull request, who merges | `.claude/rules/workflow.md` | always |
| Where code and tests go, how a module is written, how to move code | `.claude/rules/structure.md` | with `src/`, `test/` |
| Tests: kinds, mocks, what a test name says | `.claude/rules/tests.md`, `test/README.md` | with `test/` |
| User-visible text and catalogs | `.claude/rules/i18n.md` | with `src/ui/locales/`, `src/app.js`, `index.html` |
| Visual design (Primer, tokens, icons) | `.claude/rules/design.md` | with `styles.css`, `index.html` |
| The desktop app (isolation, served files, IPC) | `.claude/rules/desktop.md` | with `app/` |
| Commits, releases, prices, tuning tools, metrics | `CONTRIBUTING.md`, `docs/tuning.md` | on demand |
| Why a costly choice was made | issues labeled `decision` (`gh issue list --repo pideoh/twinscript --label decision --state all`) | on demand |

## Always

- Tests come in the same commit as a behavior change; docs for a change users can see come in the same pull request (README in both languages, `docs/`). Regenerate the README pictures only when what they show looks different: the animation (`node scripts/demo.mjs`, several megabytes per version) for the two-language listening screen, the stills (`node scripts/demo.mjs --stills`) for the three-language transcript, a recorded session with its speakers and actions, and the Summary and Questions tabs.
- No new dependencies. At runtime there is one, `mediabunny` (reads audio files in pieces): pinned to an exact version, imported only by `src/session/audio-reader.js`, served and packaged as its one bundle file; a second one would be a decision of its own (`test/unit/rules/structure.test.js` checks all of this). Dev dependencies are `playwright-core`, `electron`, `electron-builder`, `@biomejs/biome` and `axe-core` only.
- The desktop app is what is verified: what a user does on the screen is tested against it in CI (`e2e-desktop`). The interface keeps running in a plain browser, which is the tool for developing, testing and making the README pictures, not something offered to users. Desktop-only code lives in `app/`; `src/` only detects Electron.
- User-visible text goes through i18n; code, comments and commit messages are in English.
- When a change depends on how the Gemini API behaves, read the official documentation; do not rely on memory. Two assumptions about the Live API are unverified against the service: interim text is the whole utterance so far, and there is one final result per utterance.
- Commit subjects and pull request titles follow Conventional Commits (`scripts/check-commits.js` checks them). Releases are made by merging the release pull request; never edit `version` or `CHANGELOG.md`.
