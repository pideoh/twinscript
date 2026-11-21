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
npm test           # unit tests, no dependencies
npm run test:e2e   # browser tests (needs Chrome); the Gemini API is mocked
npm run test:app   # desktop smoke tests (opens windows)
```

- Add or update tests with every behavior change.
- User-visible text goes through `src/i18n.js`; add each new key to every file in `src/locales/`.
- Styling uses the Primer tokens defined at the top of `styles.css` and Octicons; no ad-hoc colors.
- No new runtime dependencies.

## Commit messages decide the release version

Every change to the app that lands on `main` is released automatically. The version bump is derived
from the commit subjects since the last release:

| Bump | When | Example |
| --- | --- | --- |
| major | body contains `BREAKING CHANGE`, or subject is `type!: ...` | saved sessions can no longer be read |
| minor | subject starts with `Add` or `feat` | `Add a caption window` |
| patch | anything else | `Fix ...`, wording, defaults |

So start a subject with `Add` only when the change adds a feature.

## Adding a display language

Copy `src/locales/en.js` to a new file, translate the values, and register it in the `LOCALES`
array in `src/i18n.js`. A unit test checks that every locale has the same keys and placeholders.

## Reporting bugs

Please include the app version (or commit), OS and browser, the audio source you used
(microphone / PC audio), and what you expected versus what happened. Opening the app with
`?debug=1` logs the raw recognizer output to the console, which helps with transcription issues.
