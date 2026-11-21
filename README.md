# Twinscript

English | [日本語](README.ja.md)

A web app (PWA) for real-time transcription and two-way translation in meetings.
Choose two languages and press "Start translating": the app detects which language is spoken, transcribes it and translates it into the other one.

![Twinscript showing a Japanese and English meeting side by side](docs/screenshot.png)

- PC (Chrome / Edge): besides the microphone, it can capture the audio of a tab or screen share (the other participants in Zoom / Teams / Meet)
- iPhone (Safari): microphone input. Use "Add to Home Screen" in the share menu to use it like an app
- A static site with no build step. Nothing runs on a server
- The UI is available in English, Japanese and Simplified Chinese. It follows the browser language and can be changed in settings

## Sessions and storage

- The list on the left holds multiple translation sessions (create, switch, rename, delete). On a phone, open it from ☰
- Transcripts and translations are saved automatically in the browser (IndexedDB) and survive a reload or closing the page
- The audio is recorded and saved as well (can be turned off in settings; about 15 MB per hour)
- From ⤓ you can download the transcript with a timeline (text / Markdown table / CSV / SRT subtitles; source and translation, source only, or translation only) and the recordings
- The data exists only in that browser on that device. It is not synced to other devices and is lost if you clear the browser's site data.
  Safari on iPhone may delete data of sites that have not been used for a long time, so download any records you want to keep

## How it works

| Role | Model |
| --- | --- |
| Transcription (streaming with interim results) | Gemini Live API `gemini-3.5-transcribe-live` |
| Translation (streaming) | `gemini-3.5-flash-lite` (can be changed in settings) |

The browser connects directly to Google's API. The API key is stored only in the browser on your device (localStorage).

## Usage

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey)
2. Start the app

   ```sh
   npm start        # http://localhost:5173
   ```

3. Open ⚙ at the top right, enter the API key, save, and press "Start translating"

Open `http://localhost:5173/?mock=1` for a demo mode that shows how the screen behaves without an API key.

### Using it on an iPhone or another PC

The microphone only works over HTTPS (or on localhost), so put this folder as-is on an HTTPS static host
(Firebase Hosting, Cloudflare Pages, GitHub Pages, etc.).

### Showing captions on top of other apps

In Chrome / Edge on a PC, press ⧉ at the top right to move the caption area into a small "always on top" window.
You can place it over Zoom or slides and resize and move it freely. Closing it puts the captions back on the main screen.
Safari and iPhone are not supported.

### Using it in online meetings

Prebuilt zips are on GitHub [Releases](../../releases). Each time app changes land on `main`,
builds for Mac (Apple silicon / Intel) and Windows are made automatically and published as a new version.

For the audio input, choose "PC audio" or "Microphone + PC audio", pick the meeting tab (or the entire screen) in the sharing dialog and
**turn on audio sharing**. With "Microphone + PC audio" the microphone picks up the speakers and the audio is doubled, so earphones are recommended.

## Desktop app (macOS / Windows)

There is also a desktop version that wraps the same code in Electron. The API key is stored inside the app (localStorage).
It differs from the browser version in two ways:

- "PC audio" captures what is playing on the PC directly, without a sharing dialog
- The ⧉ caption window is a frameless window with a transparent background that also stays on top of full-screen slides and meeting apps.
  Drag the captions to move it and close it with × at the top right

```sh
npm install
npm run app        # start for development
npm run dist:mac   # macOS zip in dist/ (Apple Silicon / Intel)
npm run dist:win   # Windows zip in dist/ (x64)
```


### PC audio on macOS

Available on macOS 13 or later (the microphone also works on earlier versions of macOS).
Twinscript must be allowed in System Settings → Privacy & Security → "Screen & System Audio Recording".
If you start without that permission, the app explains it and stops. After allowing it, reopen the app.
Running `npm run app` or `npm run dist:mac` for development also builds the PC audio capture part in Swift (Xcode command line tools).

### Opening a downloaded zip

The app is not signed or notarized, so you need to get past an OS warning the first time.

- macOS: unzip it, move "Twinscript.app" to the Applications folder and open it.
  The first time, it shows "\"Twinscript\" Not Opened". Do not move it to the Trash; press "Done",
  then scroll to the bottom of System Settings → Privacy & Security and press "Open Anyway". After that it opens normally.
  Running `xattr -dr com.apple.quarantine "/Applications/Twinscript.app"` in Terminal does the same
- Windows: right-click the zip → "Extract All" and run "Twinscript.exe" in the folder.
  If "Windows protected your PC" appears, press "More info" → "Run anyway"

To use "PC audio" on macOS, allow Twinscript in System Settings → Privacy & Security → "Screen & System Audio Recording"
and reopen the app (macOS 13 or later).

If you rebuild and replace the app, macOS may ask for microphone and screen recording permission again.

## Pricing

- Free tier: both models work on the free tier. It is rate-limited, however, and what you send is used to improve Google's products
- Paid tier (a key linked to Google Cloud billing): transcription costs about $0.009/minute (about $0.54 per hour) plus a small token fee for translation.
  What you send is not used for training. Use the paid tier for confidential meetings

## Limitations

- A transcription session lasts at most 10 minutes, so the app switches to a new connection in the background (at a pause in speech)
- It cannot tell speakers apart (who said what)
- Recordings (WebM, or M4A on iPhone) carry no duration information, so some players cannot seek in them
- When the free tier hits its rate limit, translation of sentences in progress pauses for 1 minute and only finished sentences are translated

## Tests

```sh
npm install
npm test          # unit tests (segmentation logic, transcription connection, translation). No dependencies needed
npm run test:e2e  # end-to-end tests in a browser, using the installed Chrome and a fake microphone
npm run test:app  # desktop app smoke test. It opens real windows, so run it on a PC with a display
```

The Gemini API is mocked in both, so no API key is needed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

The UI uses design tokens from Primer Primitives and icons from Octicons (both MIT, © GitHub Inc.); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
