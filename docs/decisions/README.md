# Decision records

Decisions that shape Twinscript or are costly to reverse, one file each: what the situation was, what was
decided, and what follows from it. Records 1 to 16 were written on 2026-11-25 from the pull requests they
link to; later ones are written in the pull request that makes the decision.

A record is not edited when the decision changes. A new record replaces it, and the old one's status says
which ("Replaced by 17").

| No. | Decision | Decided |
| --- | --- | --- |
| [1](0001-desktop-app-with-the-user-s-own-gemini-key-and-no-server.md) | Desktop app with the user's own Gemini key and no server | 2026-11-21 |
| [2](0002-plain-web-technology-no-build-step-no-runtime-dependencies.md) | Plain web technology: no build step, no runtime dependencies | 2026-11-21 |
| [3](0003-github-primer-as-the-visual-reference.md) | GitHub Primer as the visual reference | 2026-11-21 |
| [4](0004-keep-the-api-key-in-os-protected-storage-and-ask-the-system.md) | Keep the API key in OS-protected storage, and ask the system only when there is a key | 2026-11-21 |
| [5](0005-sign-macos-builds-with-a-fixed-self-signed-certificate-ship.md) | Sign macOS builds with a fixed self-signed certificate; ship Windows unsigned for now | 2026-11-22 |
| [6](0006-capture-pc-audio-on-macos-through-electron-s-loopback-not-a.md) | Capture PC audio on macOS through Electron's loopback, not a native helper | 2026-11-21 |
| [7](0007-decide-the-translation-direction-from-the-writing-system-whe.md) | Decide the translation direction from the writing system where it is clear | 2026-11-21 |
| [8](0008-two-languages-by-default-an-optional-third-and-one-layout-fo.md) | Two languages by default, an optional third, and one layout for both | 2026-11-23 |
| [9](0009-release-through-a-release-pull-request-conventional-commits.md) | Release through a release pull request, Conventional Commits and squash merges | 2026-11-23 |
| [10](0010-translate-the-sentence-in-progress-the-way-an-interpreter-do.md) | Translate the sentence in progress the way an interpreter does: extend, do not rewrite | 2026-11-23 |
| [11](0011-store-one-record-per-sentence-and-load-a-transcript-only-whe.md) | Store one record per sentence and load a transcript only when its session is opened | 2026-11-23 |
| [12](0012-connect-the-live-transcription-with-single-use-tokens.md) | Connect the live transcription with single-use tokens | 2026-11-23 |
| [13](0013-summaries-are-made-from-templates-as-markdown-and-all-of-the.md) | Summaries are made from templates, as Markdown, and all of them are kept | 2026-11-23 |
| [14](0014-show-usage-per-session-and-estimate-its-cost-in-us-dollars.md) | Show usage per session and estimate its cost in US dollars | 2026-11-23 |
| [15](0015-label-speakers-after-the-session-from-its-recording.md) | Label speakers after the session, from its recording | 2026-11-23 |
| [16](0016-treat-speech-as-data-in-the-translation-prompt.md) | Treat speech as data in the translation prompt | 2026-11-21 |

## Adding a record

Copy the shape of an existing file: `NNNN-short-title.md` with Status, Decided, Changes (pull requests and
issues), then Context, Decision and Consequences. Keep it to what was decided and why; how the code works
belongs in the code and in `CLAUDE.md`. Add the row to the table above.
