# Code signing policy

## Windows

The Windows build on the [Releases](https://github.com/pideoh/twinscript/releases) page is not signed, so
Windows shows a warning the first time it is opened. Each release lists SHA-256 checksums and carries a build
provenance attestation, which show that a download is the file built from this repository by the
[release workflow](../.github/workflows/release.yml).

## macOS

The macOS build is signed with the project's own self-signed certificate. This keeps the app's identity the
same between versions, so permissions granted to it survive an update. It is not a publisher certificate and
the app is not notarized by Apple, so macOS shows a warning the first time it is opened.

## Who can publish

Releases are built only from the `main` branch on GitHub-hosted runners, when a maintainer merges the release
pull request. Changes reach `main` only through pull requests that pass the required checks, merged by a
[maintainer](https://github.com/pideoh/twinscript/graphs/contributors) with write access.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by
the user or the person installing or operating it.

- When you start a session, the audio you chose to capture and the recognized text are sent to Google's
  Gemini API, using the API key you entered, to be transcribed, translated and (on request) summarized.
- The desktop app asks GitHub for the number of the latest release of this project, at most once a day, to say when
  a newer version is available. The request carries nothing about you or your sessions. Turning off "Check for new
  versions" in the settings stops it.
- Nothing else is sent anywhere. There is no telemetry, no analytics and no server operated by this project.
- Transcripts, recordings and settings stay on your computer.
