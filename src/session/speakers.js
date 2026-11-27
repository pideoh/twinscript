// Speaker labels for a finished session, told apart from its recording by the transcription model
// (src/session/diarizer.js sends the requests). Pure functions on numbers and typed arrays, DOM-free.
//
// Times: "audio time" is the position in the session's recordings played one after another (the
// recordings of a session that was stopped and started again, in order), in ms. A request covers
// one part of it; "request time" is the position in the audio sent with that request.
//
// A request takes at most 30 minutes of audio, so a long recording is sent in parts of at most
// PART_MAX_MS, consecutive parts sharing OVERLAP_MS. The model numbers the speakers of each request
// on its own, so every part after the first starts with reference clips: for every speaker known so
// far, up to CLIP_MS of that speaker talking alone, taken from what earlier parts showed. The label
// the model gives the words of a speaker's clip is that speaker in the part. Where that is not
// clear (a clip's words split between labels, two clips with one label), the speakers concerned are
// left unknown in that part rather than guessed. The overlap is only a cross-check.
//
// Words keep their text (in memory only), so the same pass can also make a new transcript
// (src/session/recording-transcript.js). A word the model gave no speaker is kept with no label: it
// is never matched to a speaker, but its text is not lost.

export const SAMPLE_RATE = 16_000;
export const PART_MAX_MS = 25 * 60_000; // of the recording, per request (the service takes 30 minutes)
export const OVERLAP_MS = 60_000; // shared by consecutive parts, used as a cross-check only
export const CLIP_MS = 20_000; // reference audio per known speaker
export const CLIP_MIN_MS = 5_000; // a speaker heard alone for less gets no clip
export const MIN_TURN_MS = 1_000; // shorter stretches of one speaker are not used for a clip
export const TURN_GAP_MS = 1_500; // a pause longer than this ends a stretch
export const PIECE_GAP_MS = 250; // silence between the stretches that make up one clip
export const CLIP_GAP_MS = 1_000; // silence between two speakers' clips
export const LEAD_GAP_MS = 2_000; // silence between the clips and the part
export const MAX_SPEAKERS = 8; // the service tells apart at most 8
export const MIN_CLIP_SHARE = 0.7; // a clip's top label must have at least this share of its words
export const MIN_OVERLAP_WORDS = 3; // a label needs this many words in the overlap to be cross-checked
// A segment is created when the recognizer first hears it, about this long after the words began.
export const SEGMENT_LEAD_MS = 1_000;

// ---------- answers ----------

/** A time from the answer in ms: "5.800s", "6s", "1.5", 1.5 (seconds) or { seconds, nanos }; NaN if unreadable. */
export function parseSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) : Number.NaN;
  if (typeof value === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*s?\s*$/i.exec(value);
    return m ? Math.round(Number(m[1]) * 1000) : Number.NaN;
  }
  if (value && typeof value === 'object' && ('seconds' in value || 'nanos' in value)) {
    const s = Number(value.seconds ?? 0);
    const n = Number(value.nanos ?? 0);
    return Number.isFinite(s) && Number.isFinite(n) ? Math.round(s * 1000 + n / 1e6) : Number.NaN;
  }
  return Number.NaN;
}

// Only punctuation and spaces: what may follow a word in the answer's text before the next word.
const BETWEEN_WORDS = /^[\s\p{P}]*$/u;

/**
 * The words of an answer, wherever they are in it: every object of type "word_info" with readable
 * times, as { startMs, endMs, label, text }, in order; label is null for a word given no speaker.
 * Where a word's start_index / end_index point at its own text in the text it annotates, the
 * punctuation that follows it there is added to its text and `space` tells whether a space follows
 * (the word annotations may carry neither, so the text is not relied on for it).
 */
export function wordsFromAnswer(answer) {
  const words = [];
  const seen = new Set();
  const visit = (node, depth, source) => {
    if (!node || typeof node !== 'object' || depth > 64 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, source);
      return;
    }
    if (node.type === 'word_info') {
      const startMs = parseSeconds(node.start_offset ?? node.startOffset);
      const endMs = parseSeconds(node.end_offset ?? node.endOffset);
      const label = typeof node.speaker === 'string' ? node.speaker.trim() : '';
      if (Number.isFinite(startMs) && startMs >= 0) {
        const text = typeof node.text === 'string' ? node.text : '';
        const at = node.start_index ?? node.startIndex;
        const to = node.end_index ?? node.endIndex;
        const placed = source && Number.isInteger(at) && Number.isInteger(to) && text && source.slice(at, to) === text;
        words.push({
          startMs,
          endMs: Number.isFinite(endMs) && endMs >= startMs ? endMs : startMs,
          label: label || null,
          text,
          ...(placed && { source, at, to }),
        });
      }
      return;
    }
    // A text with word annotations: the words' indexes point into it.
    const text = typeof node.text === 'string' && Array.isArray(node.annotations) ? node.text : source;
    for (const value of Object.values(node)) visit(value, depth + 1, text);
  };
  visit(answer, 0, null);
  attachPunctuation(words);
  return words.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs).map(({ source, at, to, ...word }) => word);
}

// Adds to each placed word the punctuation between it and the next word of the same text.
function attachPunctuation(words) {
  const bySource = new Map();
  for (const w of words) {
    if (!w.source) continue;
    if (!bySource.has(w.source)) bySource.set(w.source, []);
    bySource.get(w.source).push(w);
  }
  for (const [source, list] of bySource) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((w, i) => {
      const next = list[i + 1];
      const gap = source.slice(w.to, next && next.at >= w.to ? next.at : source.length);
      if (!BETWEEN_WORDS.test(gap)) return;
      w.text += gap.trimEnd().replace(/\s+/g, '');
      w.space = /\s/.test(gap) || !next;
    });
  }
}

/** What one answer used, shaped like usageMetadata (src/usage/usage.js). */
export function usageFromAnswer(answer) {
  const u = answer?.usage ?? {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    promptTokenCount: n(u.total_input_tokens),
    candidatesTokenCount: n(u.total_output_tokens),
    thoughtsTokenCount: n(u.total_thought_tokens),
  };
}

// ---------- parts ----------

/** The parts a recording of `totalMs` is sent in: [{ startMs, endMs }], consecutive ones sharing `overlapMs`. */
export function planParts(totalMs, { maxMs = PART_MAX_MS, overlapMs = OVERLAP_MS } = {}) {
  const parts = [];
  if (!(totalMs > 0)) return parts;
  let startMs = 0;
  for (;;) {
    const part = nextPart(startMs, totalMs, { maxMs, overlapMs });
    parts.push(part);
    if (part.endMs >= totalMs) return parts;
    startMs = part.endMs - overlapMs;
  }
}

/** The part that starts at `startMs`. Always longer than the overlap (unless the recording ends first), so parts move on. */
export function nextPart(startMs, totalMs, { maxMs = PART_MAX_MS, overlapMs = OVERLAP_MS } = {}) {
  const length = Math.max(maxMs, overlapMs + 1000);
  return { startMs, endMs: Math.min(totalMs, startMs + length) };
}

// ---------- reference clips ----------

const mid = (w) => (w.startMs + w.endMs) / 2;

/**
 * Stretches where one speaker talks alone: consecutive words of that speaker with no other speaker's
 * word between them and no pause over TURN_GAP_MS. words: [{ startMs, endMs, speaker }] in audio time.
 */
export function speakingTurns(words) {
  const turns = [];
  let turn = null;
  for (const w of words) {
    if (w.speaker == null) {
      turn = null;
      continue;
    }
    if (turn && turn.speaker === w.speaker && w.startMs - turn.endMs <= TURN_GAP_MS && w.startMs >= turn.startMs) {
      turn.endMs = Math.max(turn.endMs, w.endMs);
      turn.words++;
    } else {
      // Speech of someone else that overlaps the end of the last stretch cuts it short.
      if (turn && turn.speaker !== w.speaker && w.startMs < turn.endMs) turn.endMs = Math.max(turn.startMs, w.startMs);
      turn = { speaker: w.speaker, startMs: w.startMs, endMs: w.endMs, words: 1 };
      turns.push(turn);
    }
  }
  return turns.filter((t) => t.endMs > t.startMs);
}

/**
 * The reference clip of each speaker: [{ speaker, pieces: [{ startMs, endMs }], ms }] in audio time,
 * built from that speaker's longest stretches alone, up to CLIP_MS. Speakers heard alone for less
 * than CLIP_MIN_MS get none. At most `max` clips, for the speakers heard alone the longest; the
 * clips are in the order of the speakers' ids as given in `speakers` (or first appearance).
 */
export function chooseClips(words, { speakers, max = MAX_SPEAKERS } = {}) {
  const bySpeaker = new Map();
  for (const turn of speakingTurns(words)) {
    if (turn.endMs - turn.startMs < MIN_TURN_MS) continue;
    if (!bySpeaker.has(turn.speaker)) bySpeaker.set(turn.speaker, []);
    bySpeaker.get(turn.speaker).push(turn);
  }
  const clips = [];
  for (const [speaker, turns] of bySpeaker) {
    turns.sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs);
    const pieces = [];
    let ms = 0;
    let alone = 0;
    for (const turn of turns) {
      alone += turn.endMs - turn.startMs;
      if (ms >= CLIP_MS) continue;
      const take = Math.min(turn.endMs - turn.startMs, CLIP_MS - ms);
      pieces.push({ startMs: turn.startMs, endMs: turn.startMs + take });
      ms += take;
    }
    if (ms < CLIP_MIN_MS) continue;
    pieces.sort((a, b) => a.startMs - b.startMs);
    clips.push({ speaker, pieces, ms, alone });
  }
  clips.sort((a, b) => b.alone - a.alone);
  const kept = clips.slice(0, max);
  const order = speakers ?? [...new Set(words.map((w) => w.speaker).filter((s) => s != null))];
  const rank = (s) => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };
  return kept
    .sort((a, b) => rank(a.speaker) - rank(b.speaker))
    .map(({ speaker, pieces, ms }) => ({ speaker, pieces, ms }));
}

/**
 * Where the clips go at the start of a request: [clip][1 s][clip]…[clip][2 s][part]. Returns
 * { entries: [{ speaker, startMs, endMs, pieces: [{ fromMs, toMs, atMs }] }], refMs } in request
 * time; refMs is where the part starts (0 without clips). Pieces of one clip are PIECE_GAP_MS apart.
 */
export function referenceLayout(clips) {
  const entries = [];
  let at = 0;
  for (const clip of clips) {
    if (entries.length) at += CLIP_GAP_MS;
    const startMs = at;
    const pieces = [];
    for (const piece of clip.pieces) {
      if (pieces.length) at += PIECE_GAP_MS;
      pieces.push({ fromMs: piece.startMs, toMs: piece.endMs, atMs: at });
      at += piece.endMs - piece.startMs;
    }
    entries.push({ speaker: clip.speaker, startMs, endMs: at, pieces });
  }
  return { entries, refMs: entries.length ? at + LEAD_GAP_MS : 0 };
}

// ---------- one part's answer ----------

const majority = (counts) => {
  let top = null;
  let best = 0;
  let total = 0;
  for (const [key, n] of counts) {
    total += n;
    if (n > best) [top, best] = [key, n];
  }
  return { top, best, total };
};
const tally = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

/**
 * Reads one part's answer. words: wordsFromAnswer() of it (request time); layout: referenceLayout()
 * of its clips; part: { startMs, endMs } in audio time; previous: the words decided so far (audio
 * time, { startMs, endMs, speaker }), for the overlap check; newSpeaker(): an id for a speaker first
 * heard in this part. Returns
 *   { words: [{ startMs, endMs, speaker }] in audio time (speaker null: unknown),
 *     mapping: { [label]: speaker id | null }, added: [ids], clips: [{ speaker, words, label, share, ok, reason }],
 *     overlap: { compared, agreed: true | false | null }, uncertain }
 * A clip is not ok when it has no words ('empty'), its top label has under MIN_CLIP_SHARE of them
 * ('split') or another clip has the same top label ('clash'). Labels found in a clip that is not ok,
 * and not matched by one that is, are unknown in this part; other unmatched labels are new speakers.
 */
export function resolvePart(words, layout, part, { previous = [], newSpeaker, overlapMs = OVERLAP_MS } = {}) {
  const clips = layout.entries.map((entry) => {
    const counts = new Map();
    for (const w of words) {
      if (w.label != null && mid(w) >= entry.startMs && mid(w) <= entry.endMs) tally(counts, w.label);
    }
    const { top, best, total } = majority(counts);
    const share = total ? best / total : 0;
    const reason = !total ? 'empty' : share < MIN_CLIP_SHARE ? 'split' : null;
    return { speaker: entry.speaker, words: total, label: top, share, ok: !reason, reason, labels: [...counts.keys()] };
  });
  // Two clips whose words mostly got the same label: which speaker it is cannot be told.
  const tops = new Map();
  for (const clip of clips) if (clip.words) tally(tops, clip.label);
  for (const clip of clips)
    if (clip.words && tops.get(clip.label) > 1) Object.assign(clip, { ok: false, reason: 'clash' });

  const mapping = {};
  for (const clip of clips) if (clip.ok) mapping[clip.label] = clip.speaker;
  const doubtful = new Set(clips.filter((c) => !c.ok).flatMap((c) => c.labels));

  const inPart = words.filter((w) => mid(w) >= layout.refMs);
  const added = [];
  for (const w of inPart) {
    if (w.label == null || w.label in mapping) continue;
    if (doubtful.has(w.label)) {
      mapping[w.label] = null;
    } else {
      const id = newSpeaker();
      mapping[w.label] = id;
      added.push(id);
    }
  }

  const shift = part.startMs - layout.refMs;
  const placed = inPart
    .map((w) => ({
      startMs: w.startMs + shift,
      endMs: w.endMs + shift,
      speaker: w.label == null ? null : mapping[w.label],
      label: w.label,
      ...('text' in w && { text: w.text, space: w.space }),
    }))
    .filter((w) => mid(w) >= part.startMs && mid(w) <= part.endMs);

  const overlap = checkOverlap(previous, placed, part.startMs, Math.min(part.endMs, part.startMs + overlapMs), mapping);
  const uncertain = clips.some((c) => !c.ok) || overlap.agreed === false;
  return {
    words: placed.map(({ label, ...word }) => clean(word)),
    mapping,
    added,
    clips: clips.map(({ labels, ...clip }) => clip),
    overlap,
    uncertain,
  };
}

// A word without the fields it does not have (`space` is only known for some).
const clean = (word) => {
  if (word.space === undefined) delete word.space;
  return word;
};

/**
 * The cross-check on the overlap [fromMs, toMs): for each label of this part with enough words there,
 * the speaker most of the earlier words at the same times belong to. It disagrees when that is a
 * known speaker other than the one the label was mapped to. Returns { compared, agreed } where
 * agreed is null when nothing could be compared.
 */
export function checkOverlap(previous, placed, fromMs, toMs, mapping) {
  const earlier = previous.filter((w) => w.speaker != null && w.endMs > fromMs && w.startMs < toMs);
  const byLabel = new Map();
  for (const w of placed) {
    if (w.label == null || mid(w) < fromMs || mid(w) >= toMs) continue;
    const m = mid(w);
    const match = earlier.find((p) => p.startMs <= m && m <= p.endMs) ?? nearest(earlier, m);
    if (!match) continue;
    if (!byLabel.has(w.label)) byLabel.set(w.label, new Map());
    tally(byLabel.get(w.label), match.speaker);
  }
  let compared = 0;
  let agreed = null;
  for (const [label, counts] of byLabel) {
    const { top, total } = majority(counts);
    if (total < MIN_OVERLAP_WORDS) continue;
    compared++;
    const same = mapping[label] === top;
    agreed = (agreed ?? true) && (same || mapping[label] === null);
  }
  return { compared, agreed };
}

// The earlier word closest in time to `m`, if one is within half a second.
function nearest(words, m) {
  let best = null;
  let gap = 500;
  for (const w of words) {
    const d = Math.min(Math.abs(w.startMs - m), Math.abs(w.endMs - m));
    if (d <= gap) [best, gap] = [w, d];
  }
  return best;
}

/** Joins the words of the next part to those so far: each side keeps its words up to the middle of the overlap. */
export function mergeWords(sofar, next, overlapFromMs, overlapToMs) {
  const cut = (overlapFromMs + overlapToMs) / 2;
  return [...sofar.filter((w) => mid(w) < cut), ...next.filter((w) => mid(w) >= cut)];
}

/**
 * The final speakers, numbered by first appearance: { speakers: [{ id, name: '' }], words } where
 * ids are 's1', 's2', … in that order and the words carry them. An empty name means the default
 * one ("Speaker 1", …), shown in the display language.
 */
export function numberSpeakers(words) {
  const ids = new Map();
  for (const w of words) if (w.speaker != null && !ids.has(w.speaker)) ids.set(w.speaker, `s${ids.size + 1}`);
  return {
    speakers: [...ids.values()].map((id) => ({ id, name: '' })),
    words: words.map((w) => ({ ...w, speaker: w.speaker == null ? null : ids.get(w.speaker) })),
  };
}

// ---------- segments ----------

/**
 * Where each recording lies in audio time and in the session's time: recordings are
 * [{ elapsedStart, durationMs }] in the order they were made (elapsedStart: the session's active
 * time when it began; durationMs: the length of its decoded audio). Returns the same with audioStartMs.
 */
export function recordingTimeline(recordings) {
  let at = 0;
  return recordings.map((rec) => {
    const placed = { elapsedStart: rec.elapsedStart, durationMs: rec.durationMs, audioStartMs: at };
    at += rec.durationMs;
    return placed;
  });
}

/**
 * Each segment's span in audio time, or null for a segment outside every recording. A segment is
 * in the recording that was running at its `elapsed` (the session's active time when it was first
 * heard); its span runs from SEGMENT_LEAD_MS before that to SEGMENT_LEAD_MS before the next segment,
 * within that recording. segments: [{ elapsed }] in order; timeline: recordingTimeline().
 */
export function segmentSpans(segments, timeline) {
  const recOf = (elapsed) =>
    timeline.find((r) => elapsed >= r.elapsedStart && elapsed < r.elapsedStart + r.durationMs) ?? null;
  return segments.map((seg, i) => {
    const elapsed = seg.elapsed ?? 0;
    const rec = recOf(elapsed);
    if (!rec) return null;
    const recEnd = rec.elapsedStart + rec.durationMs;
    const next = segments.slice(i + 1).find((s) => (s.elapsed ?? 0) > elapsed);
    const from = Math.max(rec.elapsedStart, elapsed - SEGMENT_LEAD_MS);
    const to = Math.min(recEnd, next ? next.elapsed - SEGMENT_LEAD_MS : recEnd);
    if (to <= from) return null;
    const toAudio = (t) => rec.audioStartMs + t - rec.elapsedStart;
    return { startMs: toAudio(from), endMs: toAudio(to) };
  });
}

/**
 * The speaker of each segment: the one with the most speaking time among the words within its span
 * (words partly inside count with the part inside). Null with no words, a tie, or no span.
 * words: [{ startMs, endMs, speaker }] in audio time.
 */
export function assignSpeakers(segments, words, timeline) {
  return segmentSpans(segments, timeline).map((span) => {
    if (!span) return null;
    const time = new Map();
    for (const w of words) {
      if (w.speaker == null || w.endMs <= span.startMs || w.startMs >= span.endMs) continue;
      // A word given no length counts a little, so that it is not ignored.
      const inside = Math.min(w.endMs, span.endMs) - Math.max(w.startMs, span.startMs);
      time.set(w.speaker, (time.get(w.speaker) ?? 0) + Math.max(inside, 1));
    }
    let top = null;
    let best = 0;
    let tie = false;
    for (const [speaker, ms] of time) {
      if (ms > best) [top, best, tie] = [speaker, ms, false];
      else if (ms === best) tie = true;
    }
    return tie ? null : top;
  });
}

// ---------- audio ----------

const samplesOf = (ms, rate) => Math.round((ms * rate) / 1000);

/**
 * Copies audio time [fromMs, toMs) out of `pieces` ([{ samples: Int16Array }] played one after
 * another) into `out` at sample `at`.
 */
function copyRange(pieces, fromMs, toMs, out, at, rate) {
  const from = samplesOf(fromMs, rate);
  const to = samplesOf(toMs, rate);
  let offset = 0;
  for (const { samples } of pieces) {
    const end = offset + samples.length;
    const a = Math.max(from, offset);
    const b = Math.min(to, end);
    const target = at + (a - from);
    const n = Math.min(b - a, out.length - target);
    if (n > 0) out.set(samples.subarray(a - offset, a - offset + n), target);
    offset = end;
  }
}

/** Total length of `pieces` in ms. */
export const piecesMs = (pieces, rate = SAMPLE_RATE) =>
  (pieces.reduce((n, p) => n + p.samples.length, 0) * 1000) / rate;

/** The audio of one request: the clips of `layout`, silence, then `part` of the recording. Int16Array. */
export function partAudio(pieces, part, layout, rate = SAMPLE_RATE) {
  const partSamples = samplesOf(part.endMs, rate) - samplesOf(part.startMs, rate);
  const refSamples = samplesOf(layout.refMs, rate);
  const out = new Int16Array(refSamples + Math.max(0, partSamples));
  for (const entry of layout.entries) {
    for (const piece of entry.pieces)
      copyRange(pieces, piece.fromMs, piece.toMs, out, samplesOf(piece.atMs, rate), rate);
  }
  copyRange(pieces, part.startMs, part.endMs, out, refSamples, rate);
  return out;
}

/** Float samples (-1…1) as 16-bit integers. */
export function toInt16(floats) {
  const out = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i] || 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** A 16-bit mono WAV file of `samples` (Int16Array) at `rate`, as bytes. */
export function wavBytes(samples, rate = SAMPLE_RATE) {
  const data = samples.length * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // size of the fmt chunk
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}
