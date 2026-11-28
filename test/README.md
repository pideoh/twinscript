# Tests

The folder says what kind of test a file is.

| Folder | What it tests | Run |
| --- | --- | --- |
| `unit/src/` | The app's logic: one file per module in `src/`, in the same group folders (`speech/`, `translation/`, `session/`, `storage/`, `usage/`, `ui/`, `debug/`; DOM-free, no browser) | `npm test` |
| `unit/app/` | Desktop rules: modules in `app/` (policy, secrets, shortcuts, updates); Electron is not started | `npm test` |
| `unit/scripts/` | Tools: modules in `scripts/` (commit check, pricing update, metrics, tuning, macOS signing, browser coverage) | `npm test` |
| `unit/rules/` | Project rules rather than behavior: translation catalogs (`i18n`), design tokens, content security policy, web features the desktop app does not have | `npm test` |
| `e2e/` | Browser tests with Chrome, a fake microphone and mocked Gemini endpoints; one file per topic, shared setup in `helpers/` | `npm run test:e2e` |
| `desktop/` | Desktop smoke tests; they open real windows, so they need a display and are not run in CI | `npm run test:app` |
| `fixtures/` | Data files read by tests (and by `docs/tuning.md`) | |
| `support/` | Helpers shared by tests that are not tests themselves | |

Run one file with `node --test test/unit/src/speech/segmenter.test.js`.

`npm test` covers only the files the unit tests load. To see which lines of `src/` the browser tests run,
`npm run test:e2e:coverage` runs them with Chrome's coverage on (raw files in `dist/e2e-coverage/`) and
prints a table per file; `scripts/e2e-coverage.mjs` says how a line is counted.

`npm run test:e2e:desktop` runs the same browser tests against the desktop app instead of Chrome: it
first has the `electron` package fetch its binary if it is missing (`install-electron`; otherwise the
first test files to start would all fetch it at once), sets `E2E_TARGET=desktop` (from `e2e/desktop.env`), and `e2e/helpers/desktop.js` then launches the app
for each page, with its own temporary profile, the fake microphone and the same mocks. It opens real
windows, so it needs a display; CI runs it on macOS and Windows (`e2e-desktop`, three jobs per system, each
with a third of the files through Node's `--test-shard`, given in `NODE_OPTIONS`:
`NODE_OPTIONS=--test-shard=1/3 npm run test:e2e:desktop` runs the first third locally). The differences are
kept in the helpers, so a test reads the same for both:

- `download(page, action)` (`e2e/helpers/download.js`) instead of waiting for Playwright's download
  event: the desktop app saves a download into its profile without a dialog.
- A stand-in for the desktop app's bridge (`window.secretStore`, `window.appUpdates`) is handed to
  `window.__e2eStandIn` (`e2e/helpers/bridge.js`): in Chrome it becomes the bridge, in the desktop app
  the main process answers the real bridge's calls from it. Without one, the desktop app's API key
  store is kept in memory, so the system keychain is never asked.
- `browserOnly(why)` and `desktopOnly(why)` skip a test of what only one of them has, with the reason
  in the output.

## Where a new test goes

- A module in `src/<group>/`: `unit/src/<group>/<module>.test.js`. A module in `app/` or `scripts/`: the same name under `unit/app/` or `unit/scripts/`.
- A check that a rule of the project holds (not what a function returns): `unit/rules/`.
- Something a user does in the page: a new topic file in `e2e/`, with its own module under `e2e/helpers/` if it needs setup.
- Something only the packaged app can show (windows, preload, native menus): `desktop/`.
- A test that touches both `src/` and `app/` goes where its subject is.
- Unit files end in `.test.js`, browser files in `.e2e.js`, desktop files in `.app.js`. Imports use relative paths, for example `../../../../src/translation/pacer.js` from `unit/src/translation/`.
