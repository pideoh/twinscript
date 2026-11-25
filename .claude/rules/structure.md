---
paths:
  - "src/**"
  - "test/**"
  - "app/policy.js"
---

# Where code and tests go

The folders say what a file is for. Keep it that way when adding or moving code.

## Source (`src/`)

- `app.js` is the entry and the place that wires the parts together: startup, start and stop, the settings dialog, opening a session. It does not grow. New logic and new parts of the screen go into modules.
- Every other module lives in a folder by what it does: `speech/` (capture, recognition, segmentation, vocabulary), `translation/` (translation, pacing, script hints, reading aloud, the translation flow), `session/` (summaries, speaker labels, Markdown, export, saving), `storage/` (IndexedDB, settings, the API key), `usage/` (usage records, prices, totals), `ui/` (parts of the screen, i18n and locales, icons), `debug/` (trace, debug tools, demo engines).
- A new folder is rare. It needs the folder added to the files the desktop app serves (`app/policy.js`), with cases in `test/unit/app/desktop-policy.test.js` that a nested path and a traversal path under it are refused, and a row in the layout table of `CLAUDE.md`.
- There is no build step: a file's path is its URL. Moving a file means updating every import, `index.html`, URLs built in code (the audio worklet, the locales), scripts that read or rewrite modules (`scripts/update-pricing.mjs`, `scripts/tuning/`), tests that read source as text, and the docs.

## How a module is written

- Logic is DOM-free, with what it needs passed in (storage, clock, timers, `fetch`, the synthesizer), so it runs under `node:test`. `translation/pacer.js`, `translation/read-aloud.js` and `storage/settings.js` are the models.
- A part of the screen is a factory in `ui/` that takes one context object and returns a small API: `createX({ els, t, toast, settings, getCurrent, isRunning, markDirty, … })`. The session on screen and the run in progress are passed as getters, never as values. One part tells another something through a callback passed in.
- No module imports `app.js`, and no `ui/` module imports another `ui/` part: `app.js` connects them. This is what keeps imports free of cycles.
- When a part of the screen has rules in it (what is valid, what follows what, what is shown when), the rules go into a pure function or module of their own, with unit tests; the factory only reads the page and calls them.
- The order of startup matters: everything between the first and the last top-level `await` of `app.js` runs in one pass, and handlers are attached in it. A factory is called where its section's code ran, and nothing reads state before it is set. Controls that need a session stay disabled until one is shown.

## Tests (`test/`, see `test/README.md`)

- A module's unit tests mirror its place: `src/translation/pacer.js` is tested in `test/unit/src/translation/pacer.test.js`; modules in `app/` under `test/unit/app/`; tools in `scripts/` under `test/unit/scripts/`.
- A check that a rule of the project holds (catalogs, design tokens, the content security policy) goes in `test/unit/rules/`. If such a check reads source files, it must cover every file the rule applies to, not only `app.js`.
- What a user does in the page is a browser test: one file per topic in `test/e2e/`, with its setup in `test/e2e/helpers/`. What only the desktop app can show goes in `test/desktop/`.
- Shared helpers that are not tests go in `test/support/`, data in `test/fixtures/`.

## Moving code without changing behavior

- A refactor moves code; it does not fix or improve it on the way. A bug noticed while moving becomes an issue.
- The test counts before and after are the same, apart from new unit tests for logic that became testable. No existing test changes in what it checks.
- One step per commit, each passing `npm run lint` and `npm test`; the browser tests and, when `app/` or served paths are involved, `npm run test:app` pass at the end.
- A larger move is planned in an issue first: the map of what is there, the order from the least entangled part, and what stays where it is.
- Update the layout table in `CLAUDE.md`, the `paths:` of the rule files and `test/README.md` in the same pull request.
