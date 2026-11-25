# Tests

The folder says what kind of test a file is.

| Folder | What it tests | Run |
| --- | --- | --- |
| `unit/src/` | The app's logic: one file per module in `src/` (DOM-free, no browser) | `npm test` |
| `unit/app/` | Desktop rules: modules in `app/` (policy, secrets, shortcuts, updates); Electron is not started | `npm test` |
| `unit/scripts/` | Tools: modules in `scripts/` (commit check, pricing update, metrics, tuning, macOS signing) | `npm test` |
| `unit/rules/` | Project rules rather than behavior: translation catalogs (`i18n`), design tokens, content security policy | `npm test` |
| `e2e/` | Browser tests with Chrome, a fake microphone and mocked Gemini endpoints; one file per topic, shared setup in `helpers/` | `npm run test:e2e` |
| `desktop/` | Desktop smoke tests; they open real windows, so they need a display and are not run in CI | `npm run test:app` |
| `fixtures/` | Data files read by tests (and by `docs/tuning.md`) | |
| `support/` | Helpers shared by tests that are not tests themselves | |

Run one file with `node --test test/unit/src/segmenter.test.js`.

## Where a new test goes

- A module in `src/`: `unit/src/<module>.test.js`. A module in `app/` or `scripts/`: the same name under `unit/app/` or `unit/scripts/`.
- A check that a rule of the project holds (not what a function returns): `unit/rules/`.
- Something a user does in the page: a new topic file in `e2e/`, with its own module under `e2e/helpers/` if it needs setup.
- Something only the packaged app can show (windows, preload, native menus): `desktop/`.
- A test that touches both `src/` and `app/` goes where its subject is.
- Unit files end in `.test.js`, browser files in `.e2e.js`, desktop files in `.app.js`. Imports use relative paths, for example `../../../src/pacer.js` from `unit/src/`.
