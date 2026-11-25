# Contributing to Twinscript

Thanks for your interest. Bug reports, fixes, translations and features are all welcome.

## What the project is built on

[`docs/principles.md`](docs/principles.md) lists the twelve principles behind the product and the work. Read it first: when
something is not covered by a rule below, decide it from there.

The conventions, each written in one place:

| Topic | Where |
| --- | --- |
| The order of work, from an issue to a merged pull request | [`.claude/rules/workflow.md`](.claude/rules/workflow.md) |
| Where code and tests go, how a module is written | [`.claude/rules/structure.md`](.claude/rules/structure.md), [`test/README.md`](test/README.md) |
| Tests | [`.claude/rules/tests.md`](.claude/rules/tests.md) |
| User-visible text | [`.claude/rules/i18n.md`](.claude/rules/i18n.md) |
| Visual design | [`.claude/rules/design.md`](.claude/rules/design.md) |
| The desktop app | [`.claude/rules/desktop.md`](.claude/rules/desktop.md) |

They are plain Markdown and apply to everyone; the folder name only means that Claude Code loads them by itself.

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

- Tests come with every behavior change, and docs with every change users can see (README in English and Japanese, `docs/`).
- No new dependencies.
- The rest is in the conventions listed above: where code and tests go, user-visible text, visual design, the desktop app.

## Issues, discussions and decisions

- Questions and rough ideas go to [Discussions](https://github.com/pideoh/twinscript/discussions). Issues hold bugs
  and the work that has been decided on, so the issue list reads as the plan.
  The [project board](https://github.com/users/pideoh/projects/1) shows what is an idea, next, in progress and done.
- A feature or a bug fix starts from an issue. The pull request says `Closes #N` in its summary, so the issue
  closes on merge and can be found from the release notes. Small changes (typos, dependency updates, refactors,
  tests) need no issue.
- A decision that shapes the product or is costly to reverse (a storage format, an API, a release or signing
  method) is recorded as an issue with the [`decision` label](https://github.com/pideoh/twinscript/issues?q=label%3Adecision): the context, what was decided and
  what follows from it. The pull request that carries it out links to it. When a decision changes, a new issue
  replaces the old one and says so; the old one is not rewritten.

## Pull requests from a fork

You do not need write access: fork the repository, work on a branch, and open a pull request against `main`.

- For a feature, open an issue or a discussion first, so the idea can be agreed on before you write it. A bug fix
  or a small improvement can come straight as a pull request; the maintainer creates the issue if one is needed.
- The checks run on your pull request without the project's secrets. On your first contribution they start after
  a maintainer approves the run.
- Only the pull request title has to be right for the changelog; a maintainer may edit it, and may push small
  fixes to your branch if you leave "Allow edits by maintainers" on.
- The project board and preview builds are kept by the maintainer; you do not need to do anything for them.


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

How the captions feel depends on when the sentence being spoken is translated and how much of a shown translation
is rewritten. [docs/tuning.md](docs/tuning.md) describes the tools for measuring that:

- the app opened with `?debug=1` records what the recognizer delivered (a trace) and can take an audio file as input;
- `node scripts/tuning/replay.mjs <trace.json>` replays a trace through the segmentation, the pacer (`src/translation/pacer.js`) and
  the translation model, and reports delay, flicker and the number of requests (`--help` lists the options).

A trace contains what was said in the meeting. Do not commit traces or attach them to public issues;
`*.trace.json` and `twinscript-trace-*.json` are ignored by Git.

## Gemini prices

The prices used to estimate costs live in the block between `// BEGIN PRICES` and `// END PRICES` in
`src/usage/pricing.js`: the paid tier, Standard, of each model the app uses, per 1M tokens (and per minute of audio for
the live transcription model), with the date they were taken from
[Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing). To check or update them by hand:

```sh
node scripts/update-pricing.mjs           # compare with the page; exits 1 and lists the differences if any
node scripts/update-pricing.mjs --write   # rewrite the block and its date when the prices changed
```

The script fails, and writes nothing, when it cannot find a model on the page or read a price. It refuses a price
that moves by more than 5 times either way, or a model that is no longer on the page; check the page, then run it
again with `--force` to accept such a change. `--help` lists the options.

Once a month the `pricing-check` workflow runs the same check. When the prices changed it opens (or updates) a
pull request, `fix: update the Gemini prices used for cost estimates`, with the differences in its description. A
maintainer checks the numbers against the page and merges it; it is never merged automatically. When the page
cannot be read or a change is refused, the run fails instead, and the update is made by hand.

## Repository metrics

GitHub keeps views and clones for 14 days. Every Monday the `metrics` workflow records them, with referrers,
stars and release downloads, as CSV files on the `metrics` branch (`scripts/record-metrics.mjs`). It uses
the secret `RELEASE_PR_TOKEN`, which needs "Administration: read" for the traffic figures besides the
permissions the release workflow uses.

## Adding a display language

Copy `src/ui/locales/en.js` to a new file, translate the values, and register it in the `LOCALES`
array in `src/ui/i18n.js`. A unit test checks that every locale has the same keys and placeholders.

## Reporting bugs

Please include the app version (or commit), OS and browser, the audio source you used
(microphone / PC audio), and what you expected versus what happened. Opening the app with
`?debug=1` logs the raw recognizer output to the console, which helps with transcription issues.
