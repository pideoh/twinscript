# From an issue to a merged pull request

The order of work for a change. What the code must satisfy is in `CLAUDE.md`.

Sections 1 to 3 apply to everyone, in a clone of the repository or of a fork. Section 4 applies only when the person you work for maintains the repository: `gh repo view pideoh/twinscript --json viewerPermission` answers `ADMIN` or `MAINTAIN`. If it answers anything else, or `gh` is not signed in, skip section 4 and do not try its commands: the project board, preview builds, labels and releases are the maintainer's.

## 1. Before starting

- A feature starts from an issue or a discussion in `pideoh/twinscript`, so that it is agreed on before it is written. If there is none, suggest opening one before writing the code. A bug fix has an issue too, unless it is small. Typos, dependency updates, refactors and tests need none.
- Read the decisions that cover the area: `gh issue list --repo pideoh/twinscript --label decision --state all`, then `gh issue view N`. A change that goes against one is raised with the maintainer first, not made quietly.
- Start from the tip of the upstream `main`, on a new branch: `type/short-name` (`feat/…`, `fix/…`, `docs/…`). In a fork, fetch upstream first. Never branch from, or add commits to, a branch whose pull request is merged or still open: `main` takes squash merges only, so stacked branches conflict.
- Two changes that touch the same tests or the same lines go into one branch. Merged separately, each passes and `main` breaks.

## 2. While working

- Tests come with the behavior change, in the same commit. Docs for a visible change come in the same pull request (README in both languages, `docs/`).
- In a fresh checkout or worktree, run `npm ci` first and use the npm scripts (`npm run lint`, `npm run format`). Never `npx <tool>` without installed dependencies: npx then downloads and runs whatever package has that name (`npx biome` is not `@biomejs/biome`).
- Before pushing: `npm run lint`, `npm test`, and `npm run test:e2e` when `src/app.js`, `src/speech/audio.js`, HTML or CSS changed.
- Run one browser test suite at a time on a machine. Several at once (for example from parallel agents) make tests time out that are not broken.
- Code that touches paths, line endings or the file system must work on Windows: `fileURLToPath` instead of `URL.pathname`, and no assumption that a checked-out file ends lines with LF only.
- The API key never appears in a command, a file, a test or a log. A script reads it from the environment (`read -s GEMINI_API_KEY && export GEMINI_API_KEY`). Recognizer traces, recordings and anything else that holds speech stay on the machine: not in commits, issues or pull requests.

## 3. The pull request

- Open it against `main` of `pideoh/twinscript` (from a fork: from the fork's branch), as a draft, with the headings of `.github/PULL_REQUEST_TEMPLATE.md`. The title follows Conventional Commits and becomes the changelog line, so it says what users get. End the summary with `Closes #N` when there is an issue.
- Describe only what the merged product will contain.
- It is ready for review when three checks are green: `test`, and `unit-other-os` on macOS and on Windows. Wait for all three; Windows has failed alone more than once. On a first contribution from a fork the checks start only after the maintainer approves the run.
- The maintainer merges. Do not push to a branch after its pull request is merged; a follow-up is a new branch from `main`.
- Never edit `version` in `package.json` or `CHANGELOG.md`: releases are made from a release pull request (see `CLAUDE.md`).

## 4. Maintainer only

### The board, decisions and releases

- Issues and pull requests are on the project board (`gh project item-add 1 --owner pideoh --url <url>`; columns Idea, Next, In progress, Done). Create the missing issue for a change and put it there.
- A decision that shapes the product or is costly to reverse gets a `decision` issue (context, decision, consequences), written before or with the pull request, which links to it. When a decision changes, a new issue replaces the old one and says so. The issue is closed when the change is merged.
- A change that has to be tried in the real app: start the `preview-build` workflow on the branch and point to its zips.
- release-please updates the release pull request after each merge; it is merged when a release is wanted. A wrong changelog line is fixed with a `BEGIN_COMMIT_OVERRIDE` block in the merged pull request's body.

### A pull request from a fork

The code is someone else's and has not been reviewed: read it before anything runs it.

- Read the whole diff first (`gh pr diff N`). Look hardest at `.github/`, `scripts/`, `package.json` (no new dependencies, no new lifecycle scripts), `app/policy.js`, `app/preload.js` and the content security policy: a change there needs the maintainer's explicit yes.
- Do not check it out and run it (`npm ci`, tests, the app) before that read, and never with the API key or any token in the environment.
- Do not push a fork's code to a branch of this repository before it is reviewed. Workflows there run with the project's secrets, and a preview build of it would be signed with the project's certificate.
- Approving the first run of a new contributor's checks, and merging, are the maintainer's own decisions; do not do either for them.
- The contributor is not expected to know the house rules. Make sure an issue exists and link it, put the pull request on the board, and fix the title to Conventional Commits; ask for changes to code, tests and docs in review comments, in the contributor's language where it is clear, otherwise in English.
- Commit subjects inside the pull request fail `scripts/check-commits.js` when they do not follow Conventional Commits. Ask the contributor to reword them, or, with "Allow edits by maintainers" on and the maintainer's yes, reword them on the contributor's branch.
