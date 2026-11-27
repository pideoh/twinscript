// Rebuilding a session's transcript from its recording, in the page: the action and its
// confirmation, its progress and Cancel (in the toolbar above the transcript, beside the speaker
// tools), and putting back the transcript made while listening. The transcript is made by
// src/session/recording-transcript.js; the rules about what is kept and offered are in
// src/session/rebuild.js; the kept transcript is stored by store.replaceTranscript.
//
// One rebuild at a time, and none while speakers are being labelled. It goes on if another session
// is opened, and its result goes to the session it was started for. Nothing of the session changes
// until the new lines and their translations are all there: then they take the place of the old
// ones in one write, together with the kept transcript, or, if that write fails, not at all. A
// cancelled or failed rebuild leaves the session as it was; what its requests used is counted all
// the same. While it runs, the session's transcript cannot be edited and it cannot be listened to.

import { GeminiDiarizer } from '../session/diarizer.js';
import {
  applyRebuilt,
  applyRestored,
  canRebuild,
  canRestore,
  keepNames,
  putBack,
  snapshot,
  transcriptOf,
} from '../session/rebuild.js';
import { transcribeRecording } from '../session/recording-transcript.js';
import { decodeRecordings } from '../session/speaker-audio.js';
import { giveRecordingConsent } from '../session/speaker-labels.js';
import { RateLimitError, translatorFor } from '../translation/translator.js';
import { addTokens, emptyUsage } from '../usage/usage.js';
import { LANGS } from './langs.js';

// The text of the progress: which part of how many is sent or transcribed, then which line is translated.
export function progressKey({ step }) {
  if (step === 'upload') return 'speakers.uploading';
  if (step === 'analyze') return 'rebuild.transcribing';
  return 'rebuild.translating';
}

// els: the page's elements; t: i18n; store: the session store (getAudioChunks, replaceTranscript,
// loadKeptTranscript); storage: a Storage-like object for the agreement to upload recordings;
// settings: the live settings (translateModel, otherInto, glossary); toast(message, ms, variant);
// errorText(err): an error's message; uid(): a new id; getCurrent(), getRun(): the session on screen
// and the run in progress (or null); getApiKey(): the API key now; openSettings(): opens the settings
// dialog; flushSaves(): writes pending saves now; markDirty(sess): saves it soon; isDeleted(sess): the
// user deleted it; recordUsage(sess, usage): counts what a request used; isLabeling(): speakers are
// being labelled; showTranscript(sess): puts the session's lines on the page again;
// showLineError(seg, code, text): shows a line's translation error (code: its target, or null for its
// single translation); renderSummary(): redraws the summary panel and the toolbars (renderTools);
// demo: the demo (?mock=1), which has no engine for it.
export function createRebuildPanel({
  els,
  t,
  store,
  storage,
  settings,
  toast,
  errorText,
  uid,
  getCurrent,
  getRun,
  getApiKey,
  openSettings,
  flushSaves,
  markDirty,
  isDeleted,
  recordUsage,
  isLabeling,
  showTranscript,
  showLineError,
  renderSummary,
  demo = false,
}) {
  let rebuilding = null; // { session, controller, text } while a transcript is being rebuilt
  let asked = null; // the session the confirmation is open for
  let restoring = false;
  let heldToggle = false; // whether the main button was disabled here

  function renderTools() {
    const sess = getCurrent();
    if (!sess) return;
    const running = !!getRun();
    const busy = rebuilding?.session === sess;
    const offer = canRebuild(sess, running, demo);
    const restore = !busy && canRestore(sess, running);
    els.rebuildTools.hidden = running || (!busy && !offer && !restore);
    els.rebuild.hidden = !busy && !offer;
    els.rebuild.setAttribute('aria-busy', String(busy));
    els.rebuild.setAttribute('aria-disabled', String(!!rebuilding || isLabeling()));
    els.cancelRebuild.hidden = !busy;
    els.restoreTranscript.hidden = !restore;
    els.restoreTranscript.setAttribute('aria-disabled', String(!!rebuilding || isLabeling() || restoring));
    els.rebuildStatus.textContent = busy ? rebuilding.text : '';
    // Listening to a session whose transcript is being replaced would mix the two.
    if (busy) {
      els.toggle.disabled = true;
      heldToggle = true;
    } else if (heldToggle) {
      els.toggle.disabled = false;
      heldToggle = false;
    }
  }
  function setText(text) {
    rebuilding.text = text;
    if (rebuilding.session === getCurrent()) els.rebuildStatus.textContent = text;
  }

  els.rebuild.onclick = () => {
    const sess = getCurrent();
    if (rebuilding || isLabeling() || !canRebuild(sess, !!getRun(), demo)) return;
    if (!getApiKey()) {
      toast(t('toast.apiKeyFirst'), 6000, 'warning');
      return openSettings();
    }
    // What changes is always said; the agreement to upload the recording is given with it.
    els.rebuildKeep.hidden = !!sess.rebuilt;
    els.rebuildReplace.hidden = !sess.rebuilt;
    // A session made from an audio file has no transcript made while listening.
    for (const [el, key] of [
      [els.rebuildKeep, 'rebuild.keep'],
      [els.rebuildReplace, 'rebuild.replace'],
    ]) {
      el.dataset.i18n = sess.imported ? `${key}Imported` : key;
      el.textContent = t(el.dataset.i18n);
    }
    asked = sess;
    els.rebuildDialog.showModal();
  };
  els.rebuildConfirm.onclick = () => {
    const sess = asked;
    asked = null;
    els.rebuildDialog.close();
    if (!sess || sess !== getCurrent() || rebuilding || isLabeling() || !canRebuild(sess, !!getRun(), demo)) return;
    giveRecordingConsent(storage);
    rebuild(sess);
  };
  els.rebuildDialog.addEventListener('close', () => {
    asked = null;
  });
  els.cancelRebuild.onclick = () => rebuilding?.controller.abort();

  async function rebuild(sess) {
    const controller = new AbortController();
    const { signal } = controller;
    rebuilding = { session: sess, controller, text: t('speakers.preparing') };
    renderSummary();
    flushSaves(); // so the lengths of the recordings are on disk
    try {
      const apiKey = getApiKey();
      const pieces = await decodeRecordings(sess, {
        getAudioChunks: (...args) => store.getAudioChunks(...args),
        signal,
      });
      const langs = [sess.langA, sess.langB, sess.langC]
        .filter(Boolean)
        .map((code) => LANGS.find((l) => l.code === code))
        .filter(Boolean);
      const count = (kind) => (usageMetadata, model) =>
        recordUsage(sess, addTokens(emptyUsage(), kind, model, usageMetadata));
      const result = await transcribeRecording({
        pieces,
        langs,
        otherInto: settings.otherInto,
        diarizer: new GeminiDiarizer({ apiKey }),
        translator: translatorFor({
          apiKey,
          model: settings.translateModel,
          langs,
          otherInto: settings.otherInto,
          glossary: settings.glossary,
          onUsage: count('translation'),
        }),
        uid,
        signal,
        onProgress: (progress) => setText(t(progressKey(progress), progress)),
        onUsage: count('diarization'),
      });
      pieces.length = 0;
      if (isDeleted(sess)) return;
      signal.throwIfAborted();
      // The swap: in memory and on disk at once, or not at all.
      flushSaves();
      const before = snapshot(sess);
      const speakers = keepNames(transcriptOf(sess), result);
      const kept = applyRebuilt(sess, { ...result, speakers, now: Date.now() });
      try {
        await store.replaceTranscript(sess, { kept });
      } catch (err) {
        putBack(sess, before);
        throw err;
      }
      markDirty(sess);
      if (sess === getCurrent()) {
        showTranscript(sess);
        for (const { index, lang, error } of result.failures)
          showLineError(sess.segments[index], lang, errorText(error));
      }
      const failed = new Set(result.failures.map((f) => f.index)).size;
      toast(
        failed
          ? t('rebuild.doneFailed', { count: sess.segments.length, failed })
          : t('rebuild.done', { count: sess.segments.length }),
        failed ? 10000 : 6000,
        failed ? 'warning' : 'info',
      );
    } catch (err) {
      if (isDeleted(sess)) return;
      if (err?.name === 'AbortError') toast(t('rebuild.cancelled'));
      else if (err instanceof RateLimitError) toast(errorText(err), 10000, 'warning');
      else toast(t('toast.rebuildFailed', { message: errorText(err) }), 10000, 'critical');
    } finally {
      rebuilding = null;
      renderSummary();
    }
  }

  els.restoreTranscript.onclick = async () => {
    const sess = getCurrent();
    if (restoring || rebuilding || isLabeling() || !canRestore(sess, !!getRun())) return;
    if (!confirm(t('rebuild.restoreConfirm'))) return;
    restoring = true;
    renderTools();
    try {
      const kept = await store.loadKeptTranscript(sess.id);
      if (!kept) throw new Error(t('rebuild.restoreMissing'));
      if (isDeleted(sess) || getRun()) return;
      flushSaves();
      const before = snapshot(sess);
      applyRestored(sess, kept, Date.now());
      try {
        await store.replaceTranscript(sess, { kept: null });
      } catch (err) {
        putBack(sess, before);
        throw err;
      }
      markDirty(sess);
      if (sess === getCurrent()) showTranscript(sess);
      toast(t('rebuild.restored'));
    } catch (err) {
      toast(t('toast.restoreFailed', { message: errorText(err) }), 10000, 'critical');
    } finally {
      restoring = false;
      renderSummary();
    }
  };

  return {
    renderTools,
    // Whether the transcript of `sess` is being rebuilt; with null, whether any is.
    isRebuilding: (sess) => (sess === null ? !!rebuilding : rebuilding?.session === sess),
  };
}
