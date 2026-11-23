# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting instead:
open the **Security** tab of this repository and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and the version or commit you tested.

## What to keep in mind

- Twinscript has no server of its own. Audio and text go directly from your device to the Gemini API
  with the API key you enter, which is stored on your device, in the app's local storage.
- The key is sent to the Gemini API in a request header. For the live transcription it is used only to obtain a
  single-use, short-lived token for each connection, and it is not placed in the connection's address. If Google's
  token service is unavailable, the app connects with the key in the address instead for the rest of the session and
  logs a warning to the developer console.
- Transcripts and recordings are stored unencrypted on your device.
- The desktop builds are not code-signed.

Only the latest release is supported with fixes.
