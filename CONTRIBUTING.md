# Contributing to Twinscript

Thanks for your interest. Bug reports, fixes, translations and features are all welcome.

## Getting started

```sh
npm install
npm run app        # the desktop app (Electron)
npm start          # the same interface in a browser, at http://localhost:5173 (add ?mock=1 for a demo without an API key)
```

The interface is plain HTML, CSS and ES modules with no build step, so it can also be opened in a browser while developing.

## Before you open a pull request

```sh
npm run lint       # formatting and lint rules (npm run format fixes what it can)
npm test           # unit tests, no dependencies
npm run test:e2e   # browser tests (needs Chrome); the Gemini API is mocked
npm run test:app   # desktop smoke tests (opens windows)
```

- Add or update tests with every behavior change.
- If users can see the change, update the README (English and Japanese) and `docs/` in the same pull request. Regenerate
  the README animation with `node scripts/demo.mjs` only when the main screen looks different.
- User-visible text goes through `src/i18n.js`; add each new key to every file in `src/locales/`.
- Styling uses the Primer tokens defined at the top of `styles.css` and Octicons; no ad-hoc colors.
- No new runtime dependencies.

## Commit messages and releases

Pull requests are squash-merged, so the pull request title becomes the commit on `main` and its line in the changelog.
Commit subjects and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): description`, where the scope is optional. A check on every pull request rejects other forms
(`scripts/check-commits.js`). The type decides whether a change is released and how the version moves:

| Type | Use for | Released as |
| --- | --- | --- |
| `feat` | a new feature | minor (`0.7.0` → `0.8.0`) |
| `fix` | a bug fix | patch (`0.7.0` → `0.7.1`) |
| `perf` | a speed or memory improvement | patch |
| `revert` | undoing an earlier commit | patch |
| `docs`, `test`, `build`, `ci`, `chore`, `refactor`, `style` | everything else | not released on its own |

A breaking change, for example saved sessions that can no longer be read, is marked with `!` after the type
(`feat!: ...`) or with a `BREAKING CHANGE: ...` footer in the commit body, and is released as a major version.

How a release happens: after each merge to `main`, [release-please](https://github.com/googleapis/release-please)
opens or updates a pull request named `chore(main): release X.Y.Z` that sets the version in `package.json` and
adds the `feat`, `fix`, `perf` and `revert` changes to `CHANGELOG.md`. Merging that pull request tags `vX.Y.Z`,
creates the GitHub release, and builds and uploads the macOS and Windows zips to it.

Dependency updates from Dependabot are committed as `chore(deps): ...` and ship with the next release. To make
one releasable on its own, for example an Electron security fix, a maintainer can merge it with a
`fix(deps): ...` title.

To try the app before a release, a maintainer can build it from any branch: Actions → preview-build → Run workflow.
The zips are attached to that run for a week and nothing is published. The macOS build is signed like a release, so
it replaces the installed app and keeps its permissions.

## Tuning tools

Opening the app with `?debug=1` (for example http://localhost:5173/?debug=1) turns on tools for tuning segmentation
and translation timing. None of them exist without it.

- **Raw recognizer output**: every interim and final result is logged to the console as `[interim]` / `[final]`.
- **Recognizer trace**: each run records what the recognizer delivered and when. After you stop, the download dialog
  has a "Download recognizer trace (debug)" entry that saves `twinscript-trace-<yyyymmdd-hhmmss>.json`;
  `window.__twinscriptTrace()` in the console returns the same object.
- **Audio file as input**: the audio input select gets "Audio file (debug)". Starting asks for a file (audio, or WebM /
  MP4 video), which is decoded and played in real time into the recognizer, silently. The run stops by itself 2 seconds
  after the file ends. Nothing is recorded to the session. The whole file is decoded into memory first (about 11 MB
  per minute of stereo audio).

The trace format (`src/trace.js`):

```json
{
  "version": 1,
  "startedAt": "2026-11-23T01:02:03.456Z",
  "langs": ["ja-JP", "en-US"],
  "source": "mic",
  "events": [
    { "t": 812, "kind": "interim", "text": "Hello" },
    { "t": 2040, "kind": "final", "text": "Hello everyone." }
  ],
  "durationMs": 5310
}
```

`source` is `mic`, `system`, `both` or `file`; `t` is whole milliseconds since audio capture started (for a file, about where its
playback starts); `text` is the
recognizer's text before the correction rules in Settings are applied.

A trace contains what was said in the meeting. Do not commit traces or attach them to public issues;
`*.trace.json` and `twinscript-trace-*.json` are ignored by Git.

## Adding a display language

Copy `src/locales/en.js` to a new file, translate the values, and register it in the `LOCALES`
array in `src/i18n.js`. A unit test checks that every locale has the same keys and placeholders.

## Reporting bugs

Please include the app version (or commit), OS and browser, the audio source you used
(microphone / PC audio), and what you expected versus what happened. Opening the app with
`?debug=1` logs the raw recognizer output to the console, which helps with transcription issues.
