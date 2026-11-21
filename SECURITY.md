# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting instead:
open the **Security** tab of this repository and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and the version or commit you tested.

## What to keep in mind

- Twinscript has no server of its own. Audio and text go directly from your device to the Gemini API
  with the API key you enter, which is stored in the browser's (or the desktop app's) local storage.
- Transcripts and recordings are stored unencrypted on your device.
- The desktop builds are not code-signed.

Only the latest release is supported with fixes.
