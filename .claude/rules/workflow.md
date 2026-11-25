# From an issue to a merged pull request

The steps a session follows for any change. What the code must satisfy is in `CLAUDE.md`; this is the order of work.

## 1. Before starting

- A feature or a bug fix has a GitHub issue; create it if it is missing. Typos, dependency updates, refactors and tests need none.
- Read the records in `docs/decisions/` that cover the area. A change that goes against one needs a new record, not a quiet reversal.
- Fetch `main` and branch from its tip: `type/short-name` (`feat/…`, `fix/…`, `docs/…`). Never branch from, or add commits to, a branch whose pull request is merged or still open: `main` takes squash merges only, so stacked branches conflict.
- Two changes that touch the same tests or the same lines go into one branch. Merged separately, each passes and `main` breaks.

## 2. While working

- Tests come with the behavior change, in the same commit. Docs for a visible change come in the same pull request (README in both languages, `docs/`).
- Before pushing: `npm run lint`, `npm test`, and `npm run test:e2e` when `src/app.js`, `src/audio.js`, HTML or CSS changed.
- Run one browser test suite at a time on a machine. Several at once (for example from parallel agents) make tests time out that are not broken.
- Code that touches paths, line endings or the file system must work on Windows: `fileURLToPath` instead of `URL.pathname`, and no assumption that a checked-out file ends lines with LF only.
- The API key never appears in a command, a file, a test or a log. A script reads it from the environment (`read -s GEMINI_API_KEY && export GEMINI_API_KEY`). Recognizer traces, recordings and anything else that holds speech stay on the machine: not in commits, issues or pull requests.

## 3. The pull request

- Open it as a draft, with the headings of `.github/PULL_REQUEST_TEMPLATE.md`. The title follows Conventional Commits and becomes the changelog line, so it says what users get. End the summary with `Closes #N`.
- Describe only what the merged product will contain.
- It is ready to report when three checks are green: `test`, and `unit-other-os` on macOS and on Windows. Wait for all three; Windows has failed alone more than once.
- A change that has to be tried in the real app: start the `preview-build` workflow on the branch and point to its zips.
- The maintainer merges. Do not merge, and do not push to a branch after its pull request is merged; a follow-up is a new branch from `main`.

## 4. After the merge

- release-please updates the release pull request; the maintainer merges it when a release is wanted. Never edit `version` or `CHANGELOG.md` by hand. A wrong changelog line is fixed with a `BEGIN_COMMIT_OVERRIDE` block in the merged pull request's body.
- A decision that shapes the product or is costly to reverse has its record in `docs/decisions/` in the same pull request.
