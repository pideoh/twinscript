// Making a new session from an audio file, in the page: the sidebar's control, the file picker, and
// the dialog that says what will happen and where the languages are chosen, then shows the progress
// and Cancel. The file is decoded (src/session/speaker-audio.js), transcribed and translated
// (src/session/recording-transcript.js);
// the rules about files, limits and the session made are in src/session/import-audio.js.
//
// The dialog's language selects start from the languages chosen for listening each time it opens and
// follow the same rules as those (src/ui/langs.js). They belong to this import only: changing them
// changes neither the listening choice nor the saved settings (the new session, once shown, shows its
// own languages there, as any session opened does). They are held while the import runs.
//
// Nothing of the new session exists until it is complete: the lines, their translations and the decoded
// audio (src/session/import-audio.js: wavChunks) are stored in one write (store.addSession) once everything is there, and only then is the session
// listed and shown. Cancelling, a failure, or closing the app before that leaves no session and no
// audio behind; what the requests used is counted in the daily totals all the same. While the dialog
// is open the main button is held, so that a global shortcut cannot start listening meanwhile.

import { probeAudio } from '../session/audio-reader.js';
import { GeminiDiarizer } from '../session/diarizer.js';
import { formatElapsed } from '../session/exporter.js';
import {
  ACCEPT,
  checkAudio,
  checkFile,
  checkLength,
  checkWhole,
  importedSession,
  importLanguages,
  LIMITS,
  progressKey,
  WHOLE_LIMITS,
  wavChunks,
} from '../session/import-audio.js';
import { GeminiPunctuator } from '../session/punctuate.js';
import { transcribeRecording } from '../session/recording-transcript.js';
import { decodeRecording } from '../session/speaker-audio.js';
import { giveRecordingConsent } from '../session/speaker-labels.js';
import { translatorFor } from '../translation/translator.js';
import { addTokens, emptyUsage } from '../usage/usage.js';
import { followLangChange, followThirdLangChange, LANGS } from './langs.js';

const METADATA_WAIT_MS = 10_000;

// The length of a media file from its metadata, in ms, before it is decoded; NaN when the file does
// not say (a WebM recorded by a browser) or cannot be read that way. Cheap: only the header is read.
function metadataLength(file) {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = (ms) => {
      clearTimeout(timer);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    const timer = setTimeout(() => done(Number.NaN), METADATA_WAIT_MS);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration * 1000);
    audio.onerror = () => done(Number.NaN);
    audio.src = url;
  });
}

// els: the page's elements; t: i18n; store: the session store (addSession); storage: a Storage-like
// object for the agreement to upload recordings; settings: the live settings (langA, langB, langC,
// translateModel, otherInto, glossary), which this never changes; toast(message, ms, variant);
// errorText(err): an error's message; uid(): a new id; langLabel(code): a language's name; getRun(), getCurrent(): the run in
// progress (or null) and the session on screen; getApiKey(): the API key now; openSettings(): opens
// the settings dialog; recordUsage(sess, usage): counts what a request used; onImported(sess): lists
// the new session and shows it (resolves once it is on screen); showLineError(seg, code, text): shows
// a line's translation error; demo: the demo (?mock=1), which shows the control but has no engine for
// it: pressing it says so (toast.notInDemo) and opens no file picker.
export function createImportPanel({
  els,
  t,
  store,
  storage,
  settings,
  toast,
  errorText,
  uid,
  langLabel,
  getRun,
  getCurrent,
  getApiKey,
  openSettings,
  recordUsage,
  onImported,
  showLineError,
  demo = false,
}) {
  // While the dialog is open: { file, audio, controller, importing, heldToggle }.
  let job = null;

  els.importFile.accept = ACCEPT;

  // Disabled while listening, with the reason as its title (data-i18n-title keeps it in step with the display language).
  function render() {
    const running = !!getRun();
    els.importAudio.disabled = running;
    els.importAudio.dataset.i18nTitle = running ? 'import.whileListening' : 'import.button';
    els.importAudio.title = t(els.importAudio.dataset.i18nTitle);
  }

  // ---------- the languages of the import ----------
  // { A, B, C } as the selects show them ('' for no third language).
  let shown = { A: '', B: '', C: '' };
  const picked = () => ({ A: els.importLangA.value, B: els.importLangB.value, C: els.importLangC.value });
  function showLangs(langs) {
    shown = langs;
    els.importLangA.value = langs.A;
    els.importLangB.value = langs.B;
    els.importLangC.value = langs.C;
  }
  // Filled each time the dialog opens, so that the names are in the display language of the moment.
  function fillLangs() {
    for (const sel of [els.importLangA, els.importLangB, els.importLangC]) {
      sel.replaceChildren(...LANGS.map((l) => new Option(langLabel(l.code), l.code)));
    }
    els.importLangC.prepend(new Option(t('header.langC.none'), ''));
    showLangs({ A: settings.langA, B: settings.langB, C: settings.langC || '' });
  }
  function holdLangs(held) {
    for (const el of [els.importLangA, els.importLangB, els.importLangC, els.importSwap]) el.disabled = held;
  }
  els.importLangA.onchange = () => showLangs(followLangChange('A', picked(), shown));
  els.importLangB.onchange = () => showLangs(followLangChange('B', picked(), shown));
  els.importLangC.onchange = () => showLangs(followThirdLangChange(picked(), shown));
  els.importSwap.onclick = () => showLangs({ ...shown, A: shown.B, B: shown.A });

  function setStatus(text) {
    els.importStatus.textContent = text;
    els.importStatus.hidden = !text;
  }
  function showError(text) {
    els.importError.textContent = text;
    els.importError.hidden = !text;
  }
  // ready: the file can be imported; busy: something is being done with it.
  function setButtons({ ready, busy }) {
    els.importConfirm.hidden = !ready && !busy;
    els.importConfirm.disabled = busy;
    els.importConfirm.setAttribute('aria-busy', String(busy));
  }

  els.importAudio.onclick = () => {
    if (getRun() || job) return;
    if (demo) return toast(t('toast.notInDemo'), 6000, 'warning');
    if (!getApiKey()) {
      toast(t('toast.apiKeyFirst'), 6000, 'warning');
      return openSettings();
    }
    els.importFile.value = '';
    els.importFile.click();
  };
  els.importFile.onchange = () => {
    const file = els.importFile.files[0];
    els.importFile.value = '';
    if (file && !job && !getRun()) read(file);
  };

  // Opens the dialog for `file`, then reads it: whether it is taken, its length, its audio.
  async function read(file) {
    const controller = new AbortController();
    job = { file, audio: null, controller, importing: false, heldToggle: !els.toggle.disabled };
    if (job.heldToggle) els.toggle.disabled = true;
    const mine = job;
    els.importName.textContent = file.name;
    els.importDuration.textContent = '…';
    fillLangs();
    holdLangs(false);
    els.importLimits.textContent = t('import.limits', LIMITS);
    showError('');
    setButtons({ ready: false, busy: true });
    setStatus(t(progressKey({ step: 'read' })));
    els.importDialog.showModal();
    const refuse = (problem) => {
      if (job !== mine) return;
      setStatus('');
      setButtons({ ready: false, busy: false });
      els.importDuration.textContent = '';
      showError(t(problem.key, problem.params));
    };
    const refused = checkFile(file);
    if (refused) return refuse(refused);
    // Read a piece at a time where it can be (its length then comes from the library); otherwise
    // decoded whole, within the tighter limits.
    const probe = await probeAudio(file);
    if (job !== mine) return;
    const whole = !probe;
    els.importLimits.textContent = t('import.limits', whole ? WHOLE_LIMITS : LIMITS);
    const problem = whole
      ? (checkWhole(file) ?? checkLength(await metadataLength(file), { whole }))
      : checkLength(probe.seconds * 1000);
    if (job !== mine) return;
    if (problem) return refuse(problem);
    let audio;
    try {
      audio = await decodeRecording(file);
    } catch {
      return refuse({ key: 'import.undecodable' });
    }
    if (job !== mine) return;
    const bad = checkAudio(audio, { whole });
    if (bad) return refuse(bad);
    job.audio = audio;
    els.importDuration.textContent = formatElapsed(audio.durationMs);
    setStatus('');
    setButtons({ ready: true, busy: false });
  }

  els.importConfirm.onclick = () => {
    if (!job?.audio || job.importing) return;
    const apiKey = getApiKey();
    if (!apiKey) {
      els.importDialog.close();
      toast(t('toast.apiKeyFirst'), 6000, 'warning');
      return openSettings();
    }
    giveRecordingConsent(storage); // the dialog said what is uploaded, every time
    runImport(job, apiKey, shown);
  };

  // Anything that closes the dialog (Cancel, the close button, Escape) cancels what is going on.
  els.importDialog.addEventListener('close', () => {
    if (!job) return;
    const { controller, heldToggle, importing } = job;
    job = null;
    controller.abort();
    if (heldToggle) els.toggle.disabled = false;
    if (importing) toast(t('import.cancelled'));
  });

  // chosen: the languages the dialog shows, { A, B, C }.
  async function runImport(mine, apiKey, chosen) {
    mine.importing = true;
    holdLangs(true);
    showError('');
    setButtons({ ready: true, busy: true });
    setStatus(t('speakers.preparing'));
    mine.controller = new AbortController();
    const { signal } = mine.controller;
    let writing = false;
    const { codes, langs, otherInto } = importLanguages(
      chosen,
      { A: settings.langA, B: settings.langB, C: settings.langC || '' },
      settings.otherInto,
    );
    // What the requests use is counted on this until the session exists; it is never saved on its own,
    // having neither lines nor recordings.
    const counted = { usage: emptyUsage(), segments: [], recordings: [] };
    const count = (kind) => (usageMetadata, model) =>
      recordUsage(counted, addTokens(emptyUsage(), kind, model, usageMetadata));
    try {
      const result = await transcribeRecording({
        pieces: [{ samples: mine.audio.samples, elapsedStart: 0 }],
        langs,
        otherInto,
        diarizer: new GeminiDiarizer({ apiKey }),
        punctuator: new GeminiPunctuator({ apiKey, model: settings.translateModel, onUsage: count('translation') }),
        translator: translatorFor({
          apiKey,
          model: settings.translateModel,
          langs,
          otherInto,
          glossary: settings.glossary,
          onUsage: count('translation'),
        }),
        uid,
        signal,
        onProgress: (progress) => job === mine && setStatus(t(progressKey(progress), progress)),
        onUsage: count('diarization'),
      });
      signal.throwIfAborted();
      const sess = importedSession(result, {
        id: uid(),
        recId: uid(),
        now: Date.now(),
        langs: codes,
        fileName: mine.file.name,
        durationMs: mine.audio.durationMs,
        usage: counted.usage,
      });
      // From here on it is not cancelled: the session is complete and is stored in one write.
      mine.importing = false;
      writing = true;
      els.importCancel.disabled = true;
      // The decoded audio is kept, as a WAV in chunks; the file itself is not.
      const recId = sess.recordings[0].id;
      const audio = wavChunks(mine.audio.samples).map((bytes) => ({
        recId,
        blob: new Blob([bytes], { type: 'audio/wav' }),
      }));
      await store.addSession(sess, audio);
      if (job === mine) els.importDialog.close();
      await onImported(sess);
      if (sess === getCurrent())
        for (const { index, lang, error } of result.failures)
          showLineError(sess.segments[index], lang, errorText(error));
      const failed = new Set(result.failures.map((f) => f.index)).size;
      toast(
        failed
          ? t('import.doneFailed', { count: sess.segments.length, failed })
          : t('import.done', { count: sess.segments.length }),
        failed ? 10000 : 6000,
        failed ? 'warning' : 'info',
      );
    } catch (err) {
      if (signal.aborted && !writing) return; // cancelled: said when the dialog closed
      const text = t('import.failed', { message: errorText(err) });
      if (job !== mine) return toast(text, 10000, 'critical'); // the dialog was closed while it was stored
      mine.importing = false;
      holdLangs(false);
      setStatus('');
      setButtons({ ready: true, busy: false });
      showError(text);
    } finally {
      els.importCancel.disabled = false;
    }
  }

  render();
  return { render };
}
