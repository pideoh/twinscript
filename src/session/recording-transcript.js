// A transcript made from a recording after the fact, rather than while listening: the recording is
// transcribed in parts by the transcription model with speakers and word times (the same pass as
// speaker labels, src/session/diarizer.js), the words are made into sentence-sized lines, and the
// lines are translated (src/translation/batch.js). DOM-free: the recording's samples, the
// diarizer, the translator and the ids are passed in. It neither reads nor writes a session: the
// caller decides what to do with the result (src/ui/rebuild-panel.js puts it in place of a session's
// transcript).
//
// Times: words come in "audio time", the position in the recordings played one after another (see
// src/session/speakers.js). A line's `elapsed` is the session's active time at its first word: each
// recording began at its `elapsedStart` (0 for the first; for a session stopped and started again,
// the active time when it was started again), and time inside a recording is added to that. A line
// never gets an elapsed at or past the start of the next recording, so lines stay in order even when
// a recording is a little longer than the time it was counted for. Its `at` (wall clock) is the
// recording's `startedAt` plus the same offset, when the recording has one.
//
// Lines: a change of speaker or a pause of PAUSE_MS or more ends a line; within that, a line ends where
// the live segmenter would split it (src/speech/segmenter.js: a sentence end that leaves at least a
// few characters, or a clause boundary past the longest line), always between two words. Words are
// joined with a space, except between two characters of a script written without spaces (Japanese,
// Chinese) and before closing punctuation; where the model's text tells whether a space follows a
// word (`space`), that is used instead.

import { CJK, findSplit } from '../speech/segmenter.js';
import { translateLines } from '../translation/batch.js';
import { MessageError } from '../ui/message-error.js';
import { labelSpeakers, MODEL } from './diarizer.js';
import { piecesMs, recordingTimeline, SAMPLE_RATE } from './speakers.js';

export const PAUSE_MS = 1_500;

const ENDS_CJK = new RegExp(`[${CJK}]$`);
const STARTS_CJK = new RegExp(`^[${CJK}]`);
const CLOSING = /^[,.!?;:%)\]}、。，．！？；：」』）]/;

// What goes between two words of a line: '' or ' '.
function separator(prev, next) {
  if (ENDS_CJK.test(prev.text) && STARTS_CJK.test(next.text)) return '';
  if (CLOSING.test(next.text)) return '';
  if (prev.space !== undefined) return prev.space ? ' ' : '';
  return ' ';
}

// Splits the words of one stretch (one speaker, no long pause) into lines at the segmenter's cuts.
function splitStretch(words, speaker) {
  let text = '';
  const starts = [];
  const ends = [];
  words.forEach((w, i) => {
    if (i) text += separator(words[i - 1], w);
    starts.push(text.length);
    text += w.text;
    ends.push(text.length);
  });
  const lines = [];
  let from = 0;
  while (from < words.length) {
    const cut = findSplit(text.slice(starts[from]));
    let to = words.length;
    if (cut) {
      const at = starts[from] + cut;
      // After the last word that ends at or before the cut; a word longer than the cut goes whole.
      let last = from;
      while (last + 1 < words.length && ends[last + 1] <= at) last++;
      to = last + 1;
    }
    lines.push({
      startMs: words[from].startMs,
      endMs: Math.max(...words.slice(from, to).map((w) => w.endMs)),
      speaker,
      text: text.slice(starts[from], ends[to - 1]).trim(),
    });
    from = to;
  }
  return lines;
}

/**
 * Sentence-sized lines from words in order: [{ startMs, endMs, speaker, text }] in the words' time.
 * words: [{ startMs, endMs, speaker (null: unknown), text, space? }]; words without text are skipped.
 */
export function linesFromWords(words, { pauseMs = PAUSE_MS } = {}) {
  const stretches = [];
  let stretch = null;
  for (const raw of words) {
    const text = String(raw.text ?? '').trim();
    if (!text) continue;
    const w = { ...raw, text, speaker: raw.speaker ?? null };
    if (stretch && w.speaker === stretch.speaker && w.startMs - stretch.endMs < pauseMs) {
      stretch.words.push(w);
      stretch.endMs = Math.max(stretch.endMs, w.endMs);
    } else {
      stretch = { speaker: w.speaker, endMs: w.endMs, words: [w] };
      stretches.push(stretch);
    }
  }
  return stretches.flatMap((s) => splitStretch(s.words, s.speaker));
}

/**
 * Where audio time `ms` is in the session: { elapsed, at } (at: undefined when the recording's start
 * is not known). recordings: [{ elapsedStart, durationMs, startedAt? }] in order, durationMs being the
 * length of the decoded audio.
 */
export function sessionTime(recordings, ms) {
  const timeline = recordingTimeline(recordings);
  let i = timeline.findIndex((r) => ms < r.audioStartMs + r.durationMs);
  if (i < 0) i = timeline.length - 1;
  const rec = timeline[i];
  const into = Math.max(0, ms - rec.audioStartMs);
  const next = timeline[i + 1];
  const elapsed = Math.round(rec.elapsedStart + into);
  const startedAt = recordings[i].startedAt;
  return {
    elapsed: next && next.elapsedStart > rec.elapsedStart ? Math.min(elapsed, next.elapsedStart - 1) : elapsed,
    at: Number.isFinite(startedAt) ? Math.round(startedAt + into) : undefined,
  };
}

// Speaker ids renumbered s1, s2, … by the first line each speaks; speakers with no line are dropped.
function numberByLines(lines) {
  const ids = new Map();
  for (const line of lines) if (line.speaker && !ids.has(line.speaker)) ids.set(line.speaker, `s${ids.size + 1}`);
  return ids;
}

/**
 * Makes a transcript, with translations, from a recording.
 *   pieces: [{ samples: Int16Array at `rate`, elapsedStart, startedAt? }], the recordings in order;
 *   langs: [{ code, name }] (two or three) and otherInto ('A', 'B', 'C' or 'all') as for translation;
 *   diarizer: upload / analyze / remove as GeminiDiarizer; translator: as GeminiTranslator (its own
 *   onUsage counts the translations); uid(): a new line id; signal: cancels everything;
 *   onProgress({ step: 'upload' | 'analyze', part, parts } | { step: 'translate', done, total });
 *   onUsage(usageMetadata, model) for each answer of the transcription model.
 * Resolves with { segments, speakers, uncertain, model, failures, words, recordings }:
 *   segments: [{ id, elapsed, at?, src, tgt, lang?, tgts?, speaker? }] as a session keeps them;
 *   speakers: [{ id, name: '' }] numbered by first line (empty when none could be told apart);
 *   failures: [{ index, lang, error }] lines whose translation failed (see translateLines);
 *   words (audio time, speakers as in `segments`) and recordings ([{ elapsedStart, durationMs,
 *   startedAt? }]), for matching what was there before (src/session/rebuild.js).
 * Rejects with MessageError('error.speakersNone') when no speech was found, or as labelSpeakers does.
 */
export async function transcribeRecording({
  pieces,
  rate = SAMPLE_RATE,
  langs,
  otherInto = 'all',
  diarizer,
  translator,
  uid,
  signal,
  onProgress = () => {},
  onUsage = () => {},
  concurrency,
  wait,
  maxMs,
  overlapMs,
}) {
  const recordings = pieces.map((p) => ({
    elapsedStart: p.elapsedStart ?? 0,
    durationMs: piecesMs([p], rate),
    ...(Number.isFinite(p.startedAt) && { startedAt: p.startedAt }),
  }));
  const labelled = await labelSpeakers({
    pieces,
    rate,
    diarizer,
    signal,
    onProgress,
    onUsage,
    requireSpeakers: false,
    ...(maxMs && { maxMs }),
    ...(overlapMs && { overlapMs }),
  });
  const lines = linesFromWords(labelled.words);
  if (!lines.length) throw new MessageError('error.speakersNone');
  const ids = numberByLines(lines);
  const segments = lines.map((line) => {
    const { elapsed, at } = sessionTime(recordings, line.startMs);
    const speaker = ids.get(line.speaker);
    return {
      id: uid(),
      ...(at !== undefined && { at }),
      elapsed,
      src: line.text,
      tgt: '',
      ...(speaker && { speaker }),
    };
  });
  onProgress({ step: 'translate', done: 0, total: segments.length });
  const failures = await translateLines(segments, {
    langs,
    otherInto,
    translator,
    signal,
    concurrency,
    wait,
    onProgress: ({ done, total }) => onProgress({ step: 'translate', done, total }),
  });
  return {
    segments,
    speakers: [...ids.values()].map((id) => ({ id, name: '' })),
    uncertain: labelled.uncertain,
    model: MODEL,
    failures,
    words: labelled.words.map((w) => ({ ...w, speaker: ids.get(w.speaker) ?? null })),
    recordings,
  };
}
