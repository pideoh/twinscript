// Speaker labels in the page: the "identify speakers" action and its progress, the editor of the
// speakers' names, and the speaker control on each transcript line. Who spoke when is told from the
// session's recording by the transcription model (src/session/diarizer.js, src/session/speakers.js);
// the rules about a session's labels are in src/session/speaker-labels.js.
//
// One labelling at a time; it goes on if another session is opened, and its result goes to the
// session it was started for. Labelling again replaces all labels. The transcript lines themselves
// are built elsewhere: a line's speaker control is `seg.speakerEl`, filled here by showSpeaker.

import { MODEL as DIARIZE_MODEL, GeminiDiarizer, labelSpeakers } from '../session/diarizer.js';
import { formatDateTime, formatElapsed } from '../session/exporter.js';
import { decodeRecording } from '../session/speaker-audio.js';
import {
  canLabel,
  cleanSpeakerName,
  hasLabels,
  MAX_SPEAKER_NAME,
  speakerName as nameOf,
  numberByFirstLine,
} from '../session/speaker-labels.js';
import { assignSpeakers, recordingTimeline } from '../session/speakers.js';
import { RateLimitError } from '../translation/translator.js';
import { addTokens, emptyUsage } from '../usage/usage.js';
import { MessageError } from './message-error.js';

const SPEAKERS_CONSENT_KEY = 'rt-speakers-consent';

// els: the page's elements; t: i18n; octicon(name): an icon; store: the session store
// (getAudioChunks); storage: a Storage-like object (getItem / setItem) for the consent;
// toast(message, ms, variant); errorText(err): an error's message; getCurrent(), getRun(): the
// session on screen and the run in progress (or null); getApiKey(): the API key now;
// openSettings(): opens the settings dialog; flushSaves(): writes pending saves now;
// markDirty(sess): saves it soon; recordUsage(sess, usage): counts what a request used;
// renderSummary(): redraws the summary panel, which redraws the speaker tools too (renderTools);
// debug: logs how the parts were matched.
export function createSpeakerPanel({
  els,
  t,
  octicon,
  store,
  storage,
  toast,
  errorText,
  getCurrent,
  getRun,
  getApiKey,
  openSettings,
  flushSaves,
  markDirty,
  recordUsage,
  renderSummary,
  debug = false,
}) {
  let labeling = null; // { session, controller, text } while speakers are being labelled
  let speakerEditing = null; // { session, seg } while the editor is open; seg null when opened from the bar

  const speakerName = (sess, id) => nameOf(sess, id, t);

  // A line's speaker: its name, quiet, in a column of its own; an empty slot (an icon on hover) without one.
  function showSpeaker(seg) {
    const button = seg.speakerEl;
    const current = getCurrent();
    if (!button || !hasLabels(current)) return;
    const name = speakerName(current, seg.speaker);
    button.classList.toggle('none', !name);
    if (name) {
      const text = document.createElement('span');
      text.className = 'speaker-name';
      text.textContent = name;
      button.replaceChildren(text);
      button.title = name;
    } else {
      button.replaceChildren(octicon('person'));
      button.removeAttribute('title');
    }
    button.setAttribute('aria-label', name ? t('speakers.lineButton', { name }) : t('speakers.lineButtonNone'));
  }
  function renderSpeakers() {
    const current = getCurrent();
    if (!current) return;
    els.log.classList.toggle('has-speakers', hasLabels(current));
    for (const seg of current.segments ?? []) showSpeaker(seg);
    renderSpeakerTools();
  }
  function renderSpeakerTools() {
    const sess = getCurrent();
    const busy = labeling?.session === sess;
    const ready = canLabel(sess, !!getRun());
    els.speakerTools.hidden = !busy && !ready && !hasLabels(sess);
    els.labelSpeakers.hidden = !busy && !ready;
    els.labelSpeakers.setAttribute('aria-busy', String(busy));
    els.labelSpeakers.setAttribute('aria-disabled', String(!!labeling));
    els.cancelSpeakers.hidden = !busy;
    els.editSpeakers.hidden = busy || !hasLabels(sess);
    els.speakersStatus.textContent = busy ? labeling.text : '';
  }
  function setLabelingText(text) {
    labeling.text = text;
    if (labeling.session === getCurrent()) els.speakersStatus.textContent = text;
  }

  // Whether the user agreed that recordings are uploaded for this; asked once.
  function speakersConsented() {
    try {
      if (storage.getItem(SPEAKERS_CONSENT_KEY) === '1') return true;
    } catch {
      /* private mode: ask every time */
    }
    if (!confirm(t('speakers.consent'))) return false;
    try {
      storage.setItem(SPEAKERS_CONSENT_KEY, '1');
    } catch {
      /* private mode */
    }
    return true;
  }

  els.labelSpeakers.onclick = async () => {
    const sess = getCurrent();
    if (labeling || !canLabel(sess, !!getRun())) return;
    if (!getApiKey()) {
      toast(t('toast.apiKeyFirst'), 6000, 'warning');
      return openSettings();
    }
    if (!speakersConsented()) return;
    if (hasLabels(sess) && !confirm(t('speakers.replaceConfirm'))) return;
    const controller = new AbortController();
    labeling = { session: sess, controller, text: t('speakers.preparing') };
    renderSpeakerTools();
    flushSaves(); // so the lengths of the recordings are on disk
    try {
      // Each recording is decoded on its own and kept as 16 kHz mono samples (about 115 MB an hour).
      const decoded = [];
      for (const rec of sess.recordings) {
        const chunks = await store.getAudioChunks(sess.id, rec.id).catch(() => []);
        controller.signal.throwIfAborted();
        if (!chunks.length) continue;
        try {
          const audio = await decodeRecording(new Blob(chunks, { type: rec.mime }));
          if (audio.samples.length) decoded.push({ elapsedStart: rec.elapsedStart ?? 0, ...audio });
        } catch {
          /* a recording that cannot be decoded: its lines get no speaker */
        }
        controller.signal.throwIfAborted();
      }
      if (!decoded.length) throw new MessageError('error.speakersNoAudio');
      const timeline = recordingTimeline(decoded);
      const result = await labelSpeakers({
        pieces: decoded,
        diarizer: new GeminiDiarizer({ apiKey: getApiKey() }),
        signal: controller.signal,
        onProgress: ({ step, part, parts }) =>
          setLabelingText(t(step === 'upload' ? 'speakers.uploading' : 'speakers.analyzing', { part, parts })),
        onUsage: (usageMetadata, model) =>
          recordUsage(sess, addTokens(emptyUsage(), 'diarization', model, usageMetadata)),
        // How the parts were matched, to judge it on real meetings: numbers only, no speech.
        onPart: debug ? (report) => console.log('[speakers]', JSON.stringify(report)) : undefined,
      });
      decoded.length = 0;
      const { segmentSpeakers, speakers } = numberByFirstLine(assignSpeakers(sess.segments, result.words, timeline));
      sess.segments.forEach((seg, i) => {
        if (segmentSpeakers[i]) seg.speaker = segmentSpeakers[i];
        else delete seg.speaker;
      });
      sess.speakerLabels = {
        speakers,
        madeAt: Date.now(),
        uncertain: result.uncertain,
        model: DIARIZE_MODEL,
      };
      markDirty(sess);
      if (sess === getCurrent()) renderSpeakers();
      toast(
        t(result.uncertain ? 'speakers.doneUncertain' : 'speakers.done', { count: speakers.length }),
        result.uncertain ? 10000 : 6000,
        result.uncertain ? 'warning' : 'info',
      );
    } catch (err) {
      // The labels made before, if any, stay as they were.
      if (err?.name === 'AbortError') toast(t('speakers.cancelled'));
      else if (err instanceof RateLimitError) toast(errorText(err), 10000, 'warning');
      else toast(t('toast.speakersFailed', { message: errorText(err) }), 10000, 'critical');
    } finally {
      labeling = null;
      renderSummary();
    }
  };
  els.cancelSpeakers.onclick = () => labeling?.controller.abort();

  // The editor: the names of the session's speakers and, when opened from a line, that line's speaker.
  function openSpeakerEditor(seg = null) {
    const sess = getCurrent();
    if (!hasLabels(sess) || labeling?.session === sess || getRun()) return;
    const list = sess.speakerLabels.speakers;
    speakerEditing = { session: sess, seg };
    els.speakerLine.hidden = !seg;
    if (seg) {
      els.speakerLineSelect.replaceChildren(
        new Option(t('speakers.none'), ''),
        ...list.map((s) => new Option(speakerName(sess, s.id), s.id)),
      );
      els.speakerLineSelect.value = list.some((s) => s.id === seg.speaker) ? seg.speaker : '';
      els.speakerLineText.textContent = `${formatElapsed(seg.elapsed)}  ${seg.src}`;
    }
    els.speakerNames.replaceChildren(
      ...list.map((s, i) => {
        const label = document.createElement('label');
        label.className = 'form-control';
        const name = document.createElement('span');
        name.className = 'form-label';
        name.textContent = t('speakers.default', { n: i + 1 });
        const input = document.createElement('input');
        input.className = 'text-input';
        input.type = 'text';
        input.maxLength = MAX_SPEAKER_NAME;
        input.autocomplete = 'off';
        input.dataset.id = s.id;
        input.value = s.name;
        input.placeholder = t('speakers.default', { n: i + 1 });
        // Enter saves (in a dialog form it would close the dialog without saving).
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          els.speakerSave.click();
        });
        label.append(name, input);
        return label;
      }),
    );
    els.speakerUncertain.hidden = !sess.speakerLabels.uncertain;
    els.speakerNote.textContent = t('speakers.madeAt', { date: formatDateTime(sess.speakerLabels.madeAt) });
    els.speakerDialog.showModal();
    (seg ? els.speakerLineSelect : els.speakerNames.querySelector('input'))?.focus();
  }
  els.editSpeakers.onclick = () => openSpeakerEditor();
  els.speakerSave.onclick = () => {
    const { session: sess, seg } = speakerEditing ?? {};
    if (!sess || !hasLabels(sess)) return els.speakerDialog.close();
    for (const input of els.speakerNames.querySelectorAll('input')) {
      const speaker = sess.speakerLabels.speakers.find((s) => s.id === input.dataset.id);
      if (speaker) speaker.name = cleanSpeakerName(input.value);
    }
    if (seg) {
      const id = els.speakerLineSelect.value;
      if (id) seg.speaker = id;
      else delete seg.speaker;
    }
    markDirty(sess);
    if (sess === getCurrent()) renderSpeakers();
    els.speakerDialog.close();
  };
  els.speakerDialog.addEventListener('close', () => {
    speakerEditing = null;
  });

  return {
    speakerName,
    showSpeaker,
    render: renderSpeakers,
    renderTools: renderSpeakerTools,
    openEditor: openSpeakerEditor,
  };
}
