# Code signing policy

**Status: applied for, not yet in effect.** Twinscript has applied to the SignPath Foundation program for
open-source projects. Until the application is accepted and signing is set up, the Windows build on the Releases page is
not signed. The macOS build is signed with the project's own self-signed certificate, which keeps its identity
stable between versions but is not a publisher certificate and is not notarized by Apple. This page will be updated when that changes.

Once in effect: free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

## What gets signed

Only the Windows build (`twinscript-<version>-win-x64.zip`) published on this repository's
[Releases](https://github.com/pideoh/twinscript/releases) page, built from the `main` branch by the
[release workflow](../.github/workflows/release.yml) on GitHub-hosted runners. Nothing built elsewhere is signed.

## Team roles

| Role | Who |
| --- | --- |
| Committers and reviewers | [Maintainers](https://github.com/pideoh/twinscript/graphs/contributors) with write access. Changes from anyone else arrive as pull requests and are reviewed by a maintainer before merging. |
| Approvers | The repository [owner](https://github.com/pideoh). Every release is approved by hand before it is signed. |

All members with these roles use multi-factor authentication on GitHub and SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by
the user or the person installing or operating it.

- When you start a session, the audio you chose to capture and the recognized text are sent to Google's
  Gemini API, using the API key you entered, to be transcribed, translated and (on request) summarized.
- Nothing else is sent anywhere. There is no telemetry, no analytics and no server operated by this project.
- Transcripts, recordings and settings stay on your computer.
