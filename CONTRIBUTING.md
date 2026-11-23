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
- User-visible text goes through `src/i18n.js`; add each new key to every file in `src/locales/`.
- Styling uses the Primer tokens defined at the top of `styles.css` and Octicons; no ad-hoc colors.
- No new runtime dependencies.

## Commit messages and releases

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

## Adding a display language

Copy `src/locales/en.js` to a new file, translate the values, and register it in the `LOCALES`
array in `src/i18n.js`. A unit test checks that every locale has the same keys and placeholders.

## Reporting bugs

Please include the app version (or commit), OS and browser, the audio source you used
(microphone / PC audio), and what you expected versus what happened. Opening the app with
`?debug=1` logs the raw recognizer output to the console, which helps with transcription issues.
