// A session's speaker labels as the app shows and edits them: whether it has any, the name shown
// for a speaker, when a session can be labelled, how a renamed speaker's name is cleaned, how
// the speakers found are numbered, and the user's agreement to upload recordings for it. Telling the speakers apart is src/session/speakers.js. Pure,
// DOM-free.
//
// A session with labels has `speakerLabels: { speakers: [{ id, name }], madeAt, uncertain, model }`
// and each of its segments the id of its `speaker` (none when it could not be told). An empty name
// is the default one, "Speaker n", where n counts from 1 in the order of the list.

export const MAX_SPEAKER_NAME = 40;

export const hasLabels = (sess) => Array.isArray(sess?.speakerLabels?.speakers);

// The name shown for speaker `id` of `sess`, or '' for none (no labels, no id, or an id not in
// the list). t(key, params): i18n, for the default name.
export function speakerName(sess, id, t) {
  const list = hasLabels(sess) && id ? sess.speakerLabels.speakers : [];
  const i = list.findIndex((s) => s.id === id);
  return i === -1 ? '' : list[i].name || t('speakers.default', { n: i + 1 });
}

// A stopped session with speech and a recording can be labelled (the demo offers it under the same
// rule). running: whether a run is in progress.
export const canLabel = (sess, running) =>
  !running && sess.segments.some((seg) => seg.src) && sess.recordings.some((rec) => rec.durationMs > 0);

// A name as typed in the editor, as it is kept: runs of white space made one space, trimmed, and
// at most MAX_SPEAKER_NAME characters. An empty result means the default name.
export const cleanSpeakerName = (value) => value.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEAKER_NAME);

// The labels of a session from the speaker id given to each of its segments (`ids`, null or
// undefined for none, as assignSpeakers returns them): speakers are numbered s1, s2, ... by their
// first line, and one who got no line is not listed. `segmentSpeakers` holds each segment's new
// id (undefined for none); `speakers` the list, every name empty.
export function numberByFirstLine(ids) {
  const order = [...new Set(ids.filter(Boolean))];
  const renumber = new Map(order.map((id, i) => [id, `s${i + 1}`]));
  return {
    segmentSpeakers: ids.map((id) => (id ? renumber.get(id) : undefined)),
    speakers: order.map((_, i) => ({ id: `s${i + 1}`, name: '' })),
  };
}

// Whether the user agreed that a session's recording is uploaded to the API to be analyzed, which is
// asked once. Labelling speakers and rebuilding a transcript (src/ui/rebuild-panel.js) upload it the
// same way and share the agreement. storage: a Storage-like object; one that throws (private mode)
// means asking every time.
export const RECORDING_CONSENT_KEY = 'rt-speakers-consent';
export function hasRecordingConsent(storage) {
  try {
    return storage.getItem(RECORDING_CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}
export function giveRecordingConsent(storage) {
  try {
    storage.setItem(RECORDING_CONSENT_KEY, '1');
  } catch {
    /* private mode */
  }
}
