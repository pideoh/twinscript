# Twinscript

English | [日本語](README.ja.md)

A desktop app for macOS and Windows that transcribes a meeting in real time and translates it between two languages.
Choose two languages and press "Start translating": Twinscript detects which one is being spoken, writes it down and shows the translation beside it.

![A Japanese and English meeting turning into text as it is spoken, with the translation next to it](docs/demo.png)

- **Two-way**: speak in either language; no switching.
- **Hears the meeting**: transcribes the microphone, the audio playing on the computer (the other participants in Zoom, Teams, Meet), or both.
- **Translates the way an interpreter does**: what has been shown is not rewritten but continued. It works sentence by sentence, with the flow of the conversation and your own terms in mind.
- **Captions on top**: a caption window that stays above slides and meeting apps, including full screen.
- **Reads translations aloud**: finished translations can be spoken with your system's voices.
- **Keeps a record**: sessions are saved with their audio, and transcripts export with a timeline as text, Markdown, CSV or SRT.
- **Summaries after the meeting**: in the Summary tab, next to the Transcript tab, summarize a finished session with a template (quick summary, executive summary, meeting minutes, action items, customer meeting, sales call (BANT), 1:1, stand-up, or your own), choosing the length and the language it is written in. Every summary is kept with the session, so you can switch between them, copy one as Markdown or download it as `.md`. Your own templates are written in the settings and can be exported to a JSON file and imported again.
- **Questions about the meeting**: in the Questions tab, ask what was decided, who will do what or what a number was, and follow up. Answers come from the transcript, say so when the meeting does not contain the answer, and link each time they cite to that line of the transcript.
- **Who said what**: after a meeting, the speakers are told apart from its recording, and each line of the transcript shows who said it. Give the speakers their names, correct a line by hand; summaries and exports use the names.
- **Better with names**: register company and product names as terms, and correct mishearings with `wrong => right` rules.
- The interface is available in English, Japanese and Simplified Chinese.

## Install

Download the zip for your computer from [Releases](../../releases):

| File | For |
| --- | --- |
| `twinscript-<version>-mac-arm64.zip` | Mac with Apple silicon |
| `twinscript-<version>-mac-x64.zip` | Mac with an Intel processor |
| `twinscript-<version>-win-x64.zip` | Windows on an Intel or AMD processor |
| `twinscript-<version>-win-arm64.zip` | Windows on Arm (Snapdragon X and the like) |

The app is not notarized by Apple or signed with a Windows publisher certificate, so the operating system warns the first time you open it.

- **macOS**: unzip it, move "Twinscript.app" to the Applications folder and open it.
  It shows "\"Twinscript\" Not Opened". Do not move it to the Trash; press "Done", then scroll to the bottom of
  System Settings → Privacy & Security and press "Open Anyway". After that it opens normally.
  Running `xattr -dr com.apple.quarantine "/Applications/Twinscript.app"` in Terminal does the same.
- **Windows**: right-click the zip → "Extract All" and run "Twinscript.exe" in the folder.
  If "Windows protected your PC" appears, press "More info" → "Run anyway".

Each release also has a `SHA256SUMS.txt` to check the download against. See the [code signing policy](docs/code-signing-policy.md) for the state of signing.

When a newer version is released, the app says so in a notice above the transcript, with a button that opens its
release page. To update, download the new zip and replace the app with it. Close the notice to hear no more about that
version; the next one is announced again. "Check for new versions" in the settings turns this off.

## Get started

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey) ([step by step](docs/api-key.md)).
2. Open Twinscript, open the settings (gear button, top right), enter the key and save.
3. Choose the two languages and the audio input, then press "Start translating".

Each line starts with a short code for its language (JA, EN, ZH), for what was said and for its translations.

For a meeting in three languages, pick one more in the third language menu ("+ Add a language"). Every sentence is then
translated into the other two, each translation on its own line with a tag for its language. Choose "+ Add a language"
again to go back to two languages.

Speech in a language that is none of the selected ones is translated into all of them. To have it translated into one
of them only, choose that language under "When a language other than the selected ones is spoken, translate into" in
settings. With two languages, the app recognizes such speech by its writing system (Hindi in a Japanese and English
meeting) and shows both translations, each on its own tagged line; speech in a language written like one of the two
(French when English is selected) is translated into the first language, or into the one chosen in settings.

### Audio input

- **Microphone**: for a meeting in the room.
- **PC audio**: what is playing on the computer, for the other side of an online meeting.
- **Microphone + PC audio**: both. The microphone also picks up the speakers, so use earphones.

On macOS, PC audio needs macOS 14.2 or later and one permission: allow Twinscript in
System Settings → Privacy & Security → Screen & System Audio Recording → "System Audio Recording Only", then reopen the app.
If the permission is missing, the app tells you where to allow it.

The permissions you grant are kept when you update: every release is signed with the same certificate, so macOS
recognizes the new version as the same app. The one exception is the first update to a version signed this way
(releases before it had a different identity each time). If PC audio stays silent or macOS keeps asking after that
update, remove Twinscript from the list under "System Audio Recording Only" (and "Microphone") with the − button,
then open the app and allow it again.

### Captions on top of other apps

The caption window button (top right) moves the caption area into a frameless, translucent window that stays
on top of everything else, including full-screen slides and meeting apps. Drag it to move it; close it with ×.

The "Captions" group in settings changes it while you listen:

- **Show**: source and translation, or translation only. A sentence shows its source until its translation arrives.
  This applies to the caption area in the main window too.
- **Caption window text size**, separate from the text size of the main window.
- **Background opacity** from 0 to 100%. The text keeps a dark outline, so it stays readable over any background.
- **Click-through**: clicks go to the app underneath. While it is on, the caption window cannot be moved or closed
  with the mouse; hide it with the caption window button or the shortcut below.

In a browser the caption window is a picture-in-picture window, which is always opaque, so only the first two apply.

### Reading translations aloud

"Read translations aloud" in settings speaks each finished translation into the language you choose (or, with two
languages, into both) with the voices of your operating system; sentences still being spoken are not read. It takes
effect at once, also while listening. With three languages you choose one of them, and only the translations into it
are read; sentences spoken in that language are not. With two languages it needs different writing systems (such as
Japanese and English), because that is how the app tells which language a translation is in. Use headphones: from
speakers, the microphone picks up the voice and transcribes it again.

In the desktop app on Windows, reading aloud is not available while PC audio is captured ("PC audio" or
"Microphone + PC audio"): PC audio there is everything the computer plays, the app's own voice included, so the app
would transcribe and translate it again. It works with the microphone as the source; the choice in settings is kept
and applies again when you switch back to the microphone.

### Shortcuts

These work from any app while Twinscript is running, and can be turned off in settings:

| Action | macOS | Windows |
| --- | --- | --- |
| Start / stop translating | ⇧⌘T | Ctrl+Shift+T |
| Show / hide the caption window | ⇧⌘C | Ctrl+Shift+C |

If another app already uses one of them, the settings show it as unavailable. The keys cannot be changed yet.

## How it translates (modeled on simultaneous interpreting)

A simultaneous interpreter does not translate word by word, does not take back what has been said, and relies on the
flow of the conversation and on terms prepared beforehand. Twinscript's translation follows these four habits.

| What an interpreter does | What Twinscript does |
| --- | --- |
| Translates in units of meaning | Cuts speech into sentences and translates each one. However long someone talks, a translation is settled every time a sentence ends. |
| Does not take back what was said | While a sentence is being spoken, the translation on screen is kept and continued. Only what the rest of the sentence shows to be wrong is changed. When a sentence ends and the translation in progress already covers all of it, that translation is kept as it is instead of being requested again. |
| Follows the conversation | The preceding remarks and their translations are passed along as context, so references and wording stay consistent. |
| Prepares terms beforehand | The terms you register are used for recognition; your glossary and the background of the meeting are used for translation. |

This way of translating was chosen by measuring it on a recording of a real meeting. Compared with redoing the
translation of a sentence at every update, as earlier versions did, about a quarter as much shown text is rewritten
afterwards. [docs/tuning.md](docs/tuning.md) describes how it is measured.

## Sessions and storage

- The list on the left holds your sessions: create, switch, rename, delete.
- Transcripts and translations are saved automatically and are still there after you close the app.
- The audio is recorded and saved too (can be turned off in settings; about 15 MB per hour).
- The download button exports the transcript with a timeline (text / Markdown table / CSV / SRT subtitles;
  source and translation, source only, or translation only) and the recordings.
- Everything is stored on your computer, inside the app. Nothing is synced anywhere.

## Questions about a meeting

After a session, the Questions tab (next to Summary) answers questions about it. Type a question and press Enter
(Shift+Enter for a new line); the answer is written as it arrives and can be stopped.

- Answers are written by the translation model from the session's transcript (with speaker names once the speakers are
  labeled) and its summaries. When the meeting does not contain the answer, the answer says so instead of filling the
  gap. It is written in the language of the question.
- An answer gives the time of each line it relies on, such as [00:12:34]. Each time that is in the transcript is a link:
  it opens the Transcript tab at that line and marks it for a moment.
- Follow-up questions see the earlier questions and answers of the session.
- Questions and answers are saved with the session and deleted with it; each one can be deleted on its own. A question
  that was stopped or failed is not saved and stays in the field to ask again.
- A transcript too long to send whole is shortened in the middle, and the answer carries a note that it is based on
  only part of the meeting.
- Questions can be asked once a session has ended, not while listening.

## Speaker labels

After a session, "Label speakers" (in the Transcript tab, above the transcript) tells the speakers apart from the session's recording
and labels each line of the transcript with its speaker: "Speaker 1", "Speaker 2", … in the order they first speak.

- The recording is uploaded to Google's Gemini API for this (`gemini-3.5-transcribe`) and deleted there as soon as it
  has been analyzed, also when the analysis fails or is cancelled (a file whose upload was interrupted is removed by
  Google on its own after two days). The app explains this and asks once before the first
  use.
- Progress is shown per step (preparing the audio, uploading, analyzing part 1 of n) and it can be cancelled.
- "Speakers" opens the names: a name applies to every line of that speaker in the session. Activating the name on a line
  opens the same editor, where that line's speaker can be corrected (or set to none).
- Summaries made afterwards name who said, decided or will do what; a summary made before the labels is marked
  outdated. Downloads carry the speaker: before the text in `.txt` and `.srt`, in a column of its own in `.md` and
  `.csv`. Sessions without labels download as before.
- Up to 8 speakers can be told apart; with three or more the result is less reliable. Check the lines, and correct them
  where needed.
- A recording longer than 25 minutes is analyzed in parts. Each part starts with short clips of the speakers found so
  far, so that a speaker keeps one label across parts. When that match is not certain, the speakers concerned are left
  without a label in that part rather than guessed, and the editor says so.
- Labeling again replaces the labels, names and corrections, after asking.
- Only sessions with a recording can be labeled; the captions while listening do not show speakers.

## Privacy

Twinscript has no server. Audio and text go directly from your computer to Google's Gemini API with your own API key,
which is stored on your computer, encrypted by the operating system (the Keychain on macOS, DPAPI on Windows). If the
system cannot encrypt it, the key is not saved and the app asks for it again the next time.

For the live transcription, the key is sent only in a request header, to obtain a single-use, short-lived token for each
connection; the key is not placed in the connection's address. If Google's token service is unavailable, the app
connects with the key in the address instead for the rest of the session and logs a warning to the developer console.

On macOS the encryption key lives in the Keychain, in an item named "Twinscript Safe Storage". If macOS asks whether
Twinscript may use it, choose "Always Allow"; the app uses it only to read and save your API key.

- Summaries and questions about a meeting send the session's transcript (and, for questions, its summaries and the
  earlier questions and answers) to the Gemini API.
- Speaker labels upload the session's recording to the Gemini API (Files API) and delete it after the analysis.
- The desktop app asks GitHub for the number of the latest version, at most once a day. Nothing about
  you or your sessions is sent. Turn off "Check for new versions" in the settings and no request is made.
- On Gemini's free tier, what you send is used to improve Google's products. Use a paid key for confidential meetings.
- Recording or transcribing other people may require their consent.

## Pricing

- **Free tier**: both models work on it. It is rate-limited.
- **Paid tier** (a key linked to Google Cloud billing): transcription costs about $0.009 per minute (about $0.54 per hour)
  plus a small token fee for translation. What you send is not used for training.
- **Speaker labels** (`gemini-3.5-transcribe`): $2.00 per 1M input tokens, about $0.003 per minute of audio, and
  $12.00 per 1M output tokens for the transcript with word times. The audio sent is somewhat longer than the recording:
  each part after the first starts with clips of the known speakers, and parts of a long recording overlap by a minute.
- **Summaries and questions** are made with the translation model: each one is a single request whose input is
  mostly the session's transcript, so a long meeting costs more per question than a short one.
- A sentence that is translated into several languages takes one translation request (and its token fee) per language:
  every sentence with a third language, and speech in a language you did not select when it goes into all of them.

These are the prices at the time of writing; Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing) has the current ones.

### Usage and cost

The graph button in the header opens what was used and an estimate of its cost in US dollars: for the session on
screen (listening time, translation, summary, speaker-label and question requests and their tokens), totals for today, this month, last month
and everything recorded, and each saved session.

- Listening time is counted while the transcription is connected; translations, summaries, speaker labels and questions by the
  tokens the API reports for each request. Sessions saved before this screen existed show "not recorded".
- The totals are kept in the app per day (the last 400 days) and stay when a session is deleted. The demo
  (`?mock=1`) shows made-up usage for its sessions and never adds it to the totals.
- Amounts are estimates at the paid-tier prices listed in the app, with the date they were taken. With a free key
  nothing is charged. Google's billing is what counts.
- The prices can be changed in Settings → Prices for estimates, for example when they change or when you use another
  translation model, which has no price until you add one. "Reset to defaults" brings back the listed prices.

## Limitations

- Speakers are told apart only after a session, from its recording, not while listening.
- Questions are answered only after a session, not while listening. Answers come from the transcript, so what was
  misheard is answered as heard; check a cited line when it matters.
- A transcription session lasts at most 10 minutes, so the app switches to a new connection in the background, at a pause in speech.
- When the free tier hits its rate limit, translation of sentences in progress pauses for a minute; finished sentences are still translated.
- With a third language, the language of a sentence is told from its writing system. Languages that share it with
  another selected one (such as English and French, or Simplified and Traditional Chinese) are told apart by the
  translation model, which takes one more request for such a sentence. A language that is not selected but is written
  like a selected one (French when only English uses the Latin alphabet) is taken for that one.
- In the desktop app on Windows, translations are not read aloud while PC audio is captured.
- Recordings (WebM) carry no duration information, so some players cannot seek in them.

## How it works

| Role | Model |
| --- | --- |
| Transcription (streaming, with interim results) | Gemini Live API `gemini-3.5-transcribe-live` |
| Translation (streaming) | `gemini-3.5-flash-lite` (can be changed in settings) |
| Summaries and questions about a meeting | the translation model |
| Speaker labels (after a session, from its recording) | `gemini-3.5-transcribe` |

How it translates is described under [How it translates](#how-it-translates-modeled-on-simultaneous-interpreting).

The app is built with web technology and packaged with Electron.

## Development

```sh
npm install
npm run app        # run the desktop app
npm run dist:mac   # macOS zips in dist/ (Apple silicon / Intel)
npm run dist:win   # Windows zips in dist/ (x64 and arm64)
```

Releases are made from a release pull request that is kept up to date on `main`; merging it builds and publishes
the zips. Commit subjects follow Conventional Commits, which set the version (see [CONTRIBUTING.md](CONTRIBUTING.md)).

The interface also runs in a browser, which is convenient while developing:

```sh
npm start          # http://localhost:5173
```

`http://localhost:5173/?mock=1` is a demo mode that needs no API key. In a browser, PC audio comes from sharing a tab or
screen with its audio, and the caption window is a picture-in-picture window (Chrome and Edge). The API key entered
there is kept in memory only, until the page is closed. The demo has no speaker labels (they need the real service).

### Tests

```sh
npm test          # unit tests, no dependencies
npm run test:e2e  # browser tests with the installed Chrome and a fake microphone
npm run test:app  # desktop app smoke tests; they open real windows
```

The Gemini API is mocked in all of them, so no API key is needed.

## Questions, ideas and plans

- Questions and ideas: [Discussions](https://github.com/pideoh/twinscript/discussions).
- Bugs: [Issues](https://github.com/pideoh/twinscript/issues).
- What is planned, in progress and done: the [project board](https://github.com/users/pideoh/projects/1).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

The UI uses design tokens from Primer Primitives and icons from Octicons (both MIT, © GitHub Inc.); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
