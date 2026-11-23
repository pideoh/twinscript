# Tuning how translations appear

Twinscript shows the transcript as soon as the recognizer delivers it, and translates the sentence being spoken
while it is still growing. When those in-progress translations are requested, and how much of a shown translation
changes afterwards, decides how the captions feel: too eager and the text keeps being rewritten, too slow and it
falls behind the speaker. This page describes the tools for measuring that, so a change can be compared on the
same speech instead of by impression.

| Step | Tool | What you get |
| --- | --- | --- |
| 1. Record | the app with `?debug=1` | a trace: what the recognizer delivered, and when |
| 2. Replay | `scripts/tuning/replay.mjs` | a table of delay, flicker and requests per pacing strategy |
| 3. Change | `src/pacer.js` | a new strategy, compared on the same trace |

## 1. Record a trace

The debug tools exist only when the app is opened with `?debug=1`. The desktop app has no address bar, so use the
browser version:

```sh
npm ci
npm start          # then open http://localhost:5173/?debug=1 in Chrome
```

Enter your API key in the settings and select the two languages spoken.

- **From live speech**: start, speak or play audio, stop.
- **From a recording**: choose "Audio file (debug)" as the audio input and press start. Pick the file; it is decoded
  and played silently, in real time, through the same pipeline as the microphone, and the run stops by itself two
  seconds after the file ends. Press stop earlier to keep only the beginning. Nothing is saved to the session.

Then open the download dialog and choose "Download recognizer trace (debug)". The file is named
`twinscript-trace-<yyyymmdd-hhmmss>.json`.

Things to know:

- Five to ten minutes of speech are enough. A recording always plays from its start, so cut out the part you want
  beforehand.
- Recording a trace uses the live transcription model, so it costs what transcribing that much audio costs.
- Choose speech with both languages, and with stretches where one person talks for a long time: that is where
  translations fall behind.
- The whole file is decoded into memory first (about 11 MB per minute of stereo audio). WAV is tested; other formats
  that Chrome plays (MP3, M4A, MP4, WebM) are expected to work.
- **A trace contains what was said.** Keep it on your computer: do not commit it or attach it to an issue.
  `*.trace.json` and `twinscript-trace-*.json` are ignored by Git.

### Trace format

```json
{
  "version": 1,
  "startedAt": "2026-11-23T01:02:03.456Z",
  "langs": ["ja-JP", "en-US"],
  "source": "file",
  "events": [
    { "t": 812, "kind": "interim", "text": "Hello" },
    { "t": 2040, "kind": "final", "text": "Hello everyone." }
  ],
  "durationMs": 5310
}
```

`t` is whole milliseconds since audio capture started; `kind` is `interim` (the utterance so far) or `final`; `text`
is the recognizer's text before the correction rules from the settings. `source` is `mic`, `system`, `both` or `file`.

## 2. Replay and score

```sh
GEMINI_API_KEY=... node scripts/tuning/replay.mjs twinscript-trace-20261123-101500.json
```

The trace is played back on its own timestamps through the app's sentence segmentation (`src/segmenter.js`), the
pacer (`src/pacer.js`) and the real translation model, without a browser. **A run takes as long as the speech in the
trace**; a line of progress is printed every ten seconds:

```
Trace: 5:12 of speech, 941 recognizer results (58 final), Japanese / English.
Translator: gemini-3.5-flash-lite. Each strategy replays in real time: about 5:12.
  interval: 0:10 / 5:12, 2 sentences, 7 requests
  interval: 0:20 / 5:12, 4 sentences, 15 requests
```

If the first requests all fail (a wrong key, for example), the run stops and prints the error. At the end it prints
one row per strategy:

```
strategy       sentences  first ms mean/med/p90  final ms mean/med/p90  flicker mean/med/p90  erased  updates  requests  rateLimited
interval 1.5s  58         1840/1620/3100         910/840/1500           0.42/0.35/0.90        2310    212      271       0
```

(The numbers in both examples are an illustration of the layout, not a measurement.)

| Column | Meaning | Better |
| --- | --- | --- |
| `first ms` | From a sentence's first words to its first translation on screen | lower |
| `final ms` | From the end of a sentence to its complete final translation | lower |
| `flicker` | Characters of shown translation that were erased rather than extended, divided by the length of the final translation. 0: the translation only ever grew. 1: as much was rewritten as finally remained | lower |
| `erased`, `updates` | The totals behind `flicker`: characters erased, and how often the shown text changed | |
| `requests` | Translation requests sent, in-progress and final: the cost | lower |
| `rateLimited` | Requests refused by the rate limit. More than a few make the other numbers meaningless | 0 |

Each cell with three numbers is mean / median / p90 over the sentences. The table goes to standard output and
everything else to standard error, so `... > result.txt` saves the table alone.

### Options

| Option | |
| --- | --- |
| `--strategy a,b` | Pacing strategies to compare, one run after another on the same trace (default `interval`) |
| `--interval 1.5` | Seconds between in-progress translations for the `interval` strategy |
| `--out file.json` | Also write every sentence's timeline: what was shown, and when. It contains what was said |
| `--speed 4` | Play the speech faster. The model answers no faster, so delays are not comparable: for a dry run only |
| `--mock` | A fake translator on a simulated clock. No key, instant, the same numbers every time; flicker is always 0 |
| `--quiet` | Print only the table |
| `--help` | The usage text |

To check that the tool works at all, without a key:

```sh
node scripts/tuning/replay.mjs test/fixtures/replay-trace.json --mock
```

### Reading the results

- Answers from the real model differ from run to run. Compare strategies on the same trace and run each more than
  once before trusting a difference.
- Delay and flicker pull against each other: waiting longer rewrites less. Look at both columns together, and at
  `requests`, which is what a strategy costs.
- Only the first two languages of a trace are replayed.
- The replay copies the translation flow of `src/app.js` for two languages. When that flow changes, change
  `scripts/tuning/replay.mjs` with it.

## 3. Try another pacing strategy

`src/pacer.js` decides when the sentence being spoken is translated. A strategy is a function registered in
`STRATEGIES` there; `interval` (a request at most every N seconds while the text keeps changing) is what the app
uses. Add a strategy, cover it in `test/pacer.test.js`, and compare:

```sh
GEMINI_API_KEY=... node scripts/tuning/replay.mjs trace.json --strategy interval,yours
```

Make it the app's default only when the numbers and a look at the captions agree.
