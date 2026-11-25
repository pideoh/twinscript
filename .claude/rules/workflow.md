# From an issue to a merged pull request

The steps a session follows for a change made in this repository, with push access. What the code must satisfy is in `CLAUDE.md`; this is the order of work. Pull requests that arrive from a fork are in section 5; what their authors are asked to do is in `CONTRIBUTING.md`.

## 1. Before starting

- A feature or a bug fix has a GitHub issue; create it if it is missing, and put it on the project board (`gh project item-add 1 --owner pideoh --url <issue>`; columns Idea, Next, In progress, Done). Typos, dependency updates, refactors and tests need none.
- Read the decisions that cover the area: `gh issue list --label decision --state all`, then `gh issue view N`. A change that goes against one needs a new decision issue that replaces it, not a quiet reversal.
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
- A decision that shapes the product or is costly to reverse has its `decision` issue, written before or with the pull request, which links to it. The issue is closed when the change is merged.

## 5. A pull request from a fork

The code is someone else's and has not been reviewed: read it before anything runs it.

- Read the whole diff first (`gh pr diff N`). Look hardest at `.github/`, `scripts/`, `package.json` (no new dependencies, no new lifecycle scripts), `app/policy.js`, `app/preload.js` and the content security policy: a change there needs the maintainer's explicit yes.
- Do not check it out and run it (`npm ci`, tests, the app) before that read, and never with the API key or any token in the environment.
- Do not push a fork's code to a branch of this repository before it is reviewed. Workflows there run with the project's secrets, and a preview build of it would be signed with the project's certificate.
- Approving the first run of a new contributor's checks is the maintainer's decision. So is merging.
- The contributor is not expected to know the house rules. Make sure an issue exists and link it, put the pull request on the board, and fix the title to Conventional Commits; ask for changes to code, tests and docs in review comments, in the contributor's language where it is clear, otherwise in English.
- Commit subjects inside the pull request fail `scripts/check-commits.js` when they do not follow Conventional Commits. Ask the contributor to reword them, or, with "Allow edits by maintainers" on and the maintainer's yes, reword them on the contributor's branch.
