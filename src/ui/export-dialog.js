// The download dialog: the transcript in a chosen format and content, the session's recordings,
// and (debug only) the recognizer trace. The files are built by src/session/exporter.js.

import {
  buildTranscript,
  formatDateTime,
  formatElapsed,
  recordingFileName,
  safeFileName,
  serializeSession,
  transcriptLabels,
  withSpeakerNames,
} from '../session/exporter.js';

// els: the page's elements; t: i18n; octicon(name): an icon; store: the session store
// (getAudioChunks); toast(message, ms, variant); download(blob, name): saves a file;
// getCurrent(), getRun(): the session on screen and the run in progress (or null); isEmpty(sess);
// flushSaves(): writes pending saves now; getTrace(): the debug trace to offer, or null;
// traceButton(trace): its download entry; summariesOf(sess): its summaries, oldest first;
// speakerName(sess, id): a speaker's name or ''; langLabel(code): a language's name.
export function createExportDialog({
  els,
  t,
  octicon,
  store,
  toast,
  download,
  getCurrent,
  getRun,
  isEmpty,
  flushSaves,
  getTrace,
  traceButton,
  summariesOf,
  speakerName,
  langLabel,
}) {
  els.export.onclick = () => {
    if (isEmpty(getCurrent()) && !getTrace()) return toast(t('toast.nothingToSave'));
    flushSaves(); // so the title and recording lengths are up to date
    const sess = getCurrent();
    const rows = sess.recordings.map((rec, i) => {
      const row = document.createElement('div');
      row.className = 'rec';
      const info = document.createElement('span');
      const length = getRun()?.recording === rec ? t('export.recordingNow') : formatElapsed(rec.durationMs);
      // An imported file's recording has no start: when it was recorded is not known.
      info.textContent = Number.isFinite(rec.startedAt)
        ? t('export.recording', { n: i + 1, date: formatDateTime(rec.startedAt), length })
        : t('export.recordingImported', { n: i + 1, length });
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn';
      const label = document.createElement('span');
      label.textContent = t('export.save');
      save.append(octicon('download'), label);
      save.onclick = async () => {
        const chunks = await store.getAudioChunks(sess.id, rec.id).catch(() => []);
        if (!chunks.length) return toast(t('toast.recordingMissing'), 6000, 'critical');
        download(new Blob(chunks, { type: rec.mime }), recordingFileName(sess.title, i + 1, rec.mime));
      };
      row.append(info, save);
      return row;
    });
    if (rows.length) {
      const heading = document.createElement('h3');
      heading.textContent = t('export.recordings');
      rows.unshift(heading);
    }
    const trace = getTrace();
    if (trace) rows.push(traceButton(trace));
    els.recordings.replaceChildren(...rows);
    els.exportDialog.showModal();
  };

  els.exportTranscript.onclick = () => {
    const current = getCurrent();
    if (!current.segments.length) return toast(t('toast.noTranscript'));
    const latest = summariesOf(current).at(-1);
    // Names, not ids, go into the file; a session without labels has none.
    const exported = withSpeakerNames(serializeSession(current), (id) => speakerName(current, id));
    const { text, ext, mime } = buildTranscript(exported, {
      format: els.exportFormat.value,
      content: els.exportContent.value,
      langLabel,
      // The latest summary; the panel downloads any other one on its own.
      summary: latest && { markdown: latest.markdown, title: latest.templateName, truncated: latest.truncated },
      labels: transcriptLabels(t),
    });
    download(new Blob([text], { type: `${mime};charset=utf-8` }), `${safeFileName(current.title)}.${ext}`);
  };
}
