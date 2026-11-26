// The entry of the page: it wires the parts together. It reads the page (`els`), loads the settings and
// the saved sessions, creates each part of the screen (src/ui/) and the engines (speech, translation,
// session, storage, usage), and connects them with callbacks. Startup, start and stop of a run and
// opening a session are here.
// The order matters: everything between the first and the last top-level `await` runs in one pass, and
// the handlers are attached in it. No module imports this file. New logic goes into a module; see
// .claude/rules/structure.md.

import { FILE_TAIL_MS, pickAudioFile, traceDownloadButton } from './debug/debug-tools.js';
import { MockTranscriber, MockTranslator } from './debug/mock.js';
import { createTrace } from './debug/trace.js';
import { MODEL as DIARIZE_MODEL } from './session/diarizer.js';
import { formatElapsed } from './session/exporter.js';
import { createSessionSaver, isEmpty, blankSession as newSession } from './session/session-save.js';
import { hasLabels } from './session/speaker-labels.js';
import { AudioCapture, appPlatform, inMacDesktopApp } from './speech/audio.js';
import { canRecord, Recorder } from './speech/recorder.js';
import { GeminiLiveTranscriber } from './speech/transcriber.js';
import { applyReplacements, parseVocabulary } from './speech/vocabulary.js';
import { loadApiKey, saveApiKey } from './storage/secrets.js';
import { DEFAULTS, loadSettings, selectedLangs, saveSettings as writeSettings } from './storage/settings.js';
import { store } from './storage/store.js';
import { createFlow } from './translation/flow.js';
import { DEFAULT_STRATEGY, strategyNamed } from './translation/pacer.js';
import { ReadAloud } from './translation/read-aloud.js';
import { GeminiTranslator } from './translation/translator.js';
import { createCaptionWindow } from './ui/caption-window.js';
import { readElements } from './ui/elements.js';
import { createExportDialog } from './ui/export-dialog.js';
import { applyTranslations, getLocale, t } from './ui/i18n.js';
import { octicon } from './ui/icons.js';
import { LANGS } from './ui/langs.js';
import { createSettingsDialog } from './ui/settings-dialog.js';
import { createShortcutsPanel } from './ui/shortcuts-panel.js';
import { createSidebar } from './ui/sidebar.js';
import { createSpeakerPanel } from './ui/speaker-panel.js';
import { createSummaryPanel } from './ui/summary-panel.js';
import { createTemplateEditor, createTemplateStore } from './ui/template-editor.js';
import { createTranscriptView } from './ui/transcript-view.js';
import { createUpdateNotice } from './ui/update-notice.js';
import { createUsageDialog } from './ui/usage-dialog.js';
import { addTokens, emptyUsage } from './usage/usage.js';
import { createUsageLog } from './usage/usage-log.js';

const SILENT_SYSTEM_AUDIO_MS = 8000; // how long PC audio may deliver nothing before the user is told
const MOCK = new URLSearchParams(location.search).has('mock');
const DEBUG = new URLSearchParams(location.search).has('debug'); // log raw recognizer output to the console
// Debug only: the recognizer trace of the last run (src/debug/trace.js), also readable from the console.
let lastTrace = null;
if (DEBUG) window.__twinscriptTrace = () => lastTrace;
// Debug only: ?pacer=<name> picks the pacing strategy of src/translation/pacer.js for this page load.
const PACER = DEBUG ? strategyNamed(new URLSearchParams(location.search).get('pacer')) : DEFAULT_STRATEGY;

const els = readElements(document);

// ---------- settings ----------
// localStorage is reached only when something is read or written, so a page whose storage throws on
// access starts from the defaults and keeps working (the modules it is passed to catch it there).
const browserStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => localStorage.setItem(name, value),
};
// The API key is not part of the settings: it is never written to localStorage (see secrets.js).
function saveSettings() {
  writeSettings(browserStorage, settings);
}
// Earlier versions kept the key in the settings JSON: move it out and rewrite the JSON without it.
const { settings, legacyKey } = loadSettings(browserStorage);
const loadedKey = await loadApiKey(window.secretStore, legacyKey);
if (legacyKey !== undefined) saveSettings();
// The caption zone keeps its own settings while a third language is selected (see DEFAULTS in settings.js).
const captionKey = (name) => (settings.langC ? `${name}3` : name);
const reader = new ReadAloud(); // reads finished translations aloud
let captionWindow = null; // the caption window part (src/ui/caption-window.js), made in its section below

// The settings dialog, the display language and the language selects (src/ui/settings-dialog.js). The
// parts it calls are made below, so it reaches them through arrows.
const settingsDialog = createSettingsDialog({
  els,
  t,
  settings,
  saveSettings,
  captionKey,
  reader,
  apiKey: loadedKey.key,
  keyStorage: loadedKey.storage,
  saveApiKey: (key) => saveApiKey(window.secretStore, key),
  debug: DEBUG,
  getRun: () => run,
  onFontSize: () => captionWindow?.fontSize(),
  onLangsChanged: () => {
    captionWindow.applyOptions();
    if (current) {
      current.langA = settings.langA;
      current.langB = settings.langB;
      setSessionLangC(current);
      saver.markDirty(current);
    }
  },
  onRelocalize: () => {
    setStatus(statusState);
    els.toggle.textContent = t(run ? 'toggle.stop' : 'toggle.start');
    sidebar.render();
    summaryPanel.fillTemplates();
    templateEditor.renderList();
    summaryPanel.render();
    speakerPanel.render();
    shortcutsPanel.render();
    updateNotice.show();
    if (els.settings.open) usageDialog.renderPriceFields();
    if (els.usageDialog.open) usageDialog.render();
    captionWindow.relocalize();
  },
  trimCaptions: () => view.trimCaptions(),
  applyCaptionOptions: () => captionWindow.applyOptions(),
  applyClickThrough: () => captionWindow.applyClickThrough(),
  showCaptionControls: () => captionWindow.showControls(),
  showShortcuts: () => shortcutsPanel.show(),
  applyGlobalShortcuts: () => shortcutsPanel.apply(),
  closeTemplateEditor: () => templateEditor.close(),
  renderTemplateList: () => templateEditor.renderList(),
  openPriceFields: () => usageDialog.openPriceFields(),
  pendingOverrides: () => usageDialog.pendingOverrides(),
  checkForUpdates: () => updateNotice.check(),
});
const langLabel = settingsDialog.langLabel;
// A session with two languages keeps the shape it always had: no langC at all.
function setSessionLangC(sess) {
  if (settings.langC) sess.langC = settings.langC;
  else delete sess.langC;
}

// ---------- sessions (saved conversations) ----------
// { id, title, customTitle, createdAt, updatedAt, langA, langB, langC?, activeMs, segmentCount?,
//   usage?, usagePartial?, demo? (see "usage and cost estimates" below),
//   speakerLabels?: { speakers: [{ id, name }], madeAt, uncertain, model } (see "speaker labels" below),
//   segments: [{ id, at, elapsed, src, tgt, lang?, tgts?, speaker? }],
//   recordings: [{ id, startedAt, elapsedStart, durationMs, mime }],
//   summaries: [{ id, templateId, templateName, length, language, createdAt, markdown, model, truncated,
//                 segmentCount }] (oldest first),
//   summary?: { overview, keyPoints, decisions, actionItems: [{ task, owner, due }], truncated,
//               generatedAt, model, segmentCount } (the one summary an earlier version kept) }
// With a third language (langC), a segment also has `lang`, the code of the language it was
// spoken in ('other' for none of the three), and `tgts: [{ lang, text }]`, one translation per
// target language; `tgt` then holds those translations joined by line breaks, so everything that
// reads `tgt` works as with two languages.
// Saved sessions are listed without their segments (`segments` is absent and `segmentCount` says
// how many there are) and without their summaries; both are loaded the first time the session is
// shown.
let sessions = []; // saved sessions, newest first
let current = null; // the session on screen
let run = null; // the live capture/translation in progress, if any
let toastTimer;

// randomUUID needs a secure context; the fallback takes 128 bits from the same CSPRNG.
const uid = () =>
  crypto.randomUUID?.() ??
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
// Errors from audio.js, transcriber.js and translator.js carry a message key.
const errorText = (err) => (err?.key ? t(err.key, err.params) : (err?.message ?? String(err)));

// Shown as an inline banner above the transcript. variant: 'info', 'warning' or 'critical'.
function toast(message, ms = 6000, variant = 'info') {
  els.toast.textContent = message;
  els.toast.dataset.variant = variant;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

// A new, empty session in the languages selected (src/session/session-save.js).
function blankSession() {
  return newSession(settings, { id: uid(), now: Date.now() });
}

// Changed sessions are written a moment after the last change, and when the page is closed
// (src/session/session-save.js). The session being recorded gets its figures brought up to date first.
const saver = createSessionSaver({
  store,
  getSessions: () => sessions,
  beforeSave: (sess) => {
    if (run?.session === sess) {
      sess.activeMs = elapsedNow();
      if (run.recording) run.recording.durationMs = Date.now() - run.recording.startedAt;
    }
  },
  onFlushed: () => sidebar.render(), // the sidebar is made below
  onSaveFailed: (err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'),
});
window.addEventListener('pagehide', saver.flushSaves);

let opening = null; // the session whose segments are being loaded to show it
async function showSession(sess) {
  if (!sess.segments || !sess.summaries) {
    opening = sess;
    let segments, summaries;
    try {
      [segments, summaries] = await Promise.all([
        sess.segments ?? store.loadSegments(sess.id),
        sess.summaries ?? store.loadSummaries(sess.id),
      ]);
    } catch (err) {
      if (opening === sess) opening = null;
      toast(t('toast.openFailed', { message: err.message }), 6000, 'critical');
      if (!current) showSession(blankSession());
      return;
    }
    if (opening !== sess) return; // another session was chosen meanwhile
    opening = null;
    sess.segments ??= segments;
    sess.summaries ??= summaries;
    if (run && current) return; // capture started while loading
  }
  opening = null;
  reader.stop();
  current = sess;
  try {
    localStorage.setItem('rt-current', sess.id);
  } catch {
    /* private mode */
  }
  for (const node of els.log.querySelectorAll('.seg')) node.remove();
  flow.forgetLive();
  els.log.classList.toggle('has-speakers', hasLabels(sess));
  for (const seg of sess.segments) view.mount(seg);
  els.empty.hidden = sess.segments.length > 0;
  const [a, b] =
    LANGS.some((l) => l.code === sess.langA) && LANGS.some((l) => l.code === sess.langB) && sess.langA !== sess.langB
      ? [sess.langA, sess.langB]
      : [settings.langA, settings.langB];
  const langC = sess.langC;
  settingsDialog.selectLangs(a, b, LANGS.some((l) => l.code === langC) && langC !== a && langC !== b ? langC : '');
  saveSettings();
  captionWindow.applyOptions();
  els.clock.textContent = formatElapsed(sess.activeMs);
  els.log.scrollTop = els.log.scrollHeight;
  document.body.classList.remove('drawer');
  sidebar.render();
  summaryPanel.render();
}

// The list of saved sessions, the new session button and the drawer (src/ui/sidebar.js).
const sidebar = createSidebar({
  els,
  t,
  octicon,
  store,
  toast,
  getSessions: () => sessions,
  removeSession: (sess) => {
    sessions = sessions.filter((x) => x !== sess);
  },
  forgetSave: (sess) => saver.forget(sess),
  getCurrent: () => current,
  getRun: () => run,
  showSession,
  blankSession,
  markDirty: saver.markDirty,
});

// ---------- transcript view ----------
// The segments on the page and the code that leads each line (src/ui/transcript-view.js).
const view = createTranscriptView({
  els,
  settings,
  getCurrent: () => current,
  getRun: () => run,
  captionKey,
  langLabel,
  // the speaker panel is made below
  showSpeaker: (seg) => speakerPanel.showSpeaker(seg),
  openSpeakerEditor: (seg) => speakerPanel.openEditor(seg),
});

// ---------- caption window ----------
// The caption zone in an always-on-top window, and the caption zone's settings that apply at once
// (src/ui/caption-window.js).
captionWindow = createCaptionWindow({
  els,
  t,
  applyTranslations,
  octicon,
  settings,
  captionKey,
  toast,
  errorText,
  applyFontSize: settingsDialog.applyFontSize,
});

// ---------- global shortcuts (desktop app) ----------
// The settings' list of shortcuts and their switch (src/ui/shortcuts-panel.js); each shortcut does
// what its button does.
const shortcutsPanel = createShortcutsPanel({
  els,
  t,
  settings,
  bridge: () => window.appShortcuts,
  onCommand: (command) => {
    if (command === 'toggle') els.toggle.click();
    else if (command === 'captions' && !els.pip.hidden) els.pip.click();
  },
});

// ---------- newer versions (desktop app) ----------
// The notice of a newer version, and when to ask for one (src/ui/update-notice.js).
const updateNotice = createUpdateNotice({ els, t, settings, storage: browserStorage, bridge: () => window.appUpdates });

// ---------- download ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// The download dialog (src/ui/export-dialog.js).
createExportDialog({
  els,
  t,
  octicon,
  store,
  toast,
  download,
  getCurrent: () => current,
  getRun: () => run,
  isEmpty,
  flushSaves: saver.flushSaves,
  getTrace: () => (DEBUG ? lastTrace : null),
  traceButton: (trace) => traceDownloadButton(trace, download),
  // the summary and speaker panels are made below
  summariesOf: (sess) => summaryPanel.summariesOf(sess),
  speakerName: (sess, id) => speakerPanel.speakerName(sess, id),
  langLabel,
});

// ---------- summary ----------
// The summary panel (src/ui/summary-panel.js); which summaries a session has and which one is
// shown are in src/session/summaries.js.

// The user's own templates (src/ui/template-editor.js), read from localStorage here.
const templates = createTemplateStore({ storage: browserStorage, t });

const summaryPanel = createSummaryPanel({
  els,
  t,
  getLocale,
  settings,
  saveSettings,
  storage: browserStorage,
  store,
  toast,
  errorText,
  download,
  uid,
  templates,
  langLabel,
  getCurrent: () => current,
  getRun: () => run,
  getApiKey: settingsDialog.apiKey,
  openSettings: settingsDialog.open,
  markDirty: saver.markDirty,
  isDeleted: (sess) => saver.isForgotten(sess),
  // the usage log and the speaker panel are made below
  recordUsage: (sess, usage) => usageLog.recordUsage(sess, usage),
  speakerName: (sess, id) => speakerPanel.speakerName(sess, id),
  renderSpeakerTools: () => speakerPanel.renderTools(),
  mock: MOCK,
});

// ---------- speaker labels ----------
// After a session, who spoke when is told from its recording (src/ui/speaker-panel.js); the rules
// about a session's labels are in src/session/speaker-labels.js. Speaker names and the speaker
// control of each line are also used by the transcript, the summary and the export.
const speakerPanel = createSpeakerPanel({
  els,
  t,
  octicon,
  store,
  storage: browserStorage,
  toast,
  errorText,
  getCurrent: () => current,
  getRun: () => run,
  getApiKey: settingsDialog.apiKey,
  openSettings: settingsDialog.open,
  flushSaves: saver.flushSaves,
  markDirty: saver.markDirty,
  isDeleted: (sess) => saver.isForgotten(sess),
  recordUsage: (sess, usage) => usageLog.recordUsage(sess, usage), // the usage log is made below
  renderSummary: summaryPanel.render,
  debug: DEBUG,
  demo: MOCK,
});

// ---------- summary templates (settings dialog) ----------
const templateEditor = createTemplateEditor({
  els,
  t,
  octicon,
  templates,
  uid,
  errorText,
  download,
  onTemplatesChanged: () => summaryPanel.fillTemplates(),
});

// ---------- usage and cost estimates ----------
// What each session used and the daily totals (src/usage/usage-log.js), the usage dialog and the price
// fields in the settings (src/ui/usage-dialog.js). In the demo mode the made-up usage goes into its
// session only.
const usageLog = createUsageLog({
  settings,
  storage: browserStorage,
  demo: MOCK,
  isEmpty,
  markDirty: saver.markDirty,
  onRecorded: () => usageDialog.refresh(),
});
const usageDialog = createUsageDialog({
  els,
  t,
  getLocale,
  settings,
  getCurrent: () => current,
  getSessions: () => sessions,
  getRun: () => run,
  usageLog,
  defaultTranslateModel: DEFAULTS.translateModel,
  diarizeModel: DIARIZE_MODEL,
});

// ---------- live run ----------
let wakeLock = null;

// Active (recording) time of the current session, which is what segment timestamps show.
function elapsedNow() {
  return run?.startedAt ? run.baseMs + Date.now() - run.startedAt : current.activeMs;
}

let statusState = 'idle';
function setStatus(state) {
  const dot = { idle: '', connecting: 'busy', listening: 'on', reconnecting: 'busy' };
  statusState = state;
  els.dot.className = `dot ${dot[state]}`;
  els.statusText.textContent = t(`status.${state}`);
}

function setRunning(running) {
  els.toggle.textContent = t(running ? 'toggle.stop' : 'toggle.start');
  els.toggle.classList.toggle('stop', running);
  document.body.classList.toggle('running', running);
  els.now.hidden = !running;
  for (const el of [els.langA, els.langB, els.langC, els.swap, els.source, els.newSession]) el.disabled = running;
  if (!running) {
    setStatus('idle');
    els.level.style.width = '0';
  }
  summaryPanel.render();
}

els.toggle.onclick = () => (run ? stop() : start());

async function start() {
  const apiKey = settingsDialog.apiKey();
  if (!MOCK && !apiKey) {
    window.appShortcuts?.focusApp().catch(() => {}); // when started by a shortcut from another app
    toast(t('toast.apiKeyFirst'), 6000, 'warning');
    return settingsDialog.open();
  }
  const langA = LANGS.find((l) => l.code === settings.langA);
  const langB = LANGS.find((l) => l.code === settings.langB);
  const langC = LANGS.find((l) => l.code === settings.langC);
  const sess = current;
  sess.langA = langA.code;
  sess.langB = langB.code;
  setSessionLangC(sess);
  const r = {
    session: sess,
    // what the translator was given, whatever the selects say later
    langs: langC ? [langA, langB, langC] : [langA, langB],
    baseMs: sess.activeMs,
    startedAt: 0,
    otherInto: settings.otherInto,
  };
  r.tracker = flow.tracker(r);
  r.pacer = flow.pacer(r);
  run = r;
  setRunning(true);
  setStatus('connecting');

  const vocabulary = parseVocabulary(settings.vocabulary);
  const handlers = {
    onInterim: (text) => {
      if (DEBUG) console.log('[interim]', text);
      if (run === r) r.trace?.add('interim', text);
      if (run === r) r.tracker.interim(applyReplacements(text, vocabulary.rules));
    },
    onFinal: (text) => {
      if (DEBUG) console.log('[final]', text);
      if (run === r) r.trace?.add('final', text);
      if (run === r) r.tracker.final(applyReplacements(text, vocabulary.rules));
    },
    onState: (state) => {
      if (run !== r) return;
      usageLog.accrueListening(r);
      r.listeningSince = state === 'listening' ? Date.now() : 0;
      setStatus(state);
    },
    onError: (err) => {
      if (run === r) {
        toast(errorText(err), 10000, 'critical');
        stop();
      }
    },
  };
  // Every translation request of the run (in progress, final, per-target lines, identify) is counted.
  const onUsage = (usageMetadata, model) =>
    usageLog.recordUsage(sess, addTokens(emptyUsage(), 'translation', model, usageMetadata));
  if (MOCK) {
    r.translator = new MockTranslator({ model: settings.translateModel, onUsage });
    r.transcriber = new MockTranscriber(handlers);
  } else {
    r.translator = new GeminiTranslator({
      apiKey,
      model: settings.translateModel,
      onUsage,
      langA: langA.name,
      langB: langB.name,
      langC: langC?.name,
      glossary: settings.glossary,
      // For the rules of two languages; 'all' gives the first language there, as before. Speech
      // that its writing system shows to be neither language never reaches those rules with 'all'.
      otherInto: (r.otherInto === 'B' ? langB : langA).name,
    });
    r.transcriber = new GeminiLiveTranscriber({
      apiKey,
      languageCodes: r.langs.map((l) => l.code),
      smart: settings.smart,
      customVocabulary: vocabulary.terms,
      ...handlers,
    });
  }

  try {
    if (!MOCK) {
      const file = settings.source === 'file' ? await pickAudioFile() : undefined;
      if (file === null) return run === r && stop(); // the file picker was cancelled
      if (run !== r) return;
      r.capture = new AudioCapture({
        onChunk: (b64) => r.transcriber.sendAudio(b64),
        onLevel: (rms) => {
          els.level.style.width = `${Math.min(100, rms * 400)}%`;
        },
        onEnded: (err) => {
          if (run === r) {
            toast(err ? errorText(err) : t('toast.audioEnded'), err ? 20000 : 6000, err ? 'critical' : 'info');
            stop();
          }
        },
        onFileEnded: () => {
          setTimeout(() => {
            if (run !== r) return;
            toast(t('toast.audioEnded'));
            stop();
          }, FILE_TAIL_MS);
        },
      });
      await r.capture.start(settings.source, file);
      if (run !== r) return r.capture.stop(); // stopped while the permission prompt was open
    }
    r.startedAt = Date.now();
    // Times in the trace count from here, which for a file is (about) where its playback starts.
    if (DEBUG) r.trace = createTrace({ langs: r.langs.map((l) => l.code), source: settings.source });
    if (!MOCK && settings.record && settings.source !== 'file' && canRecord()) startRecording(r);
    r.transcriber.start();
    r.ticker = setInterval(() => {
      els.clock.textContent = formatElapsed(elapsedNow());
    }, 500);
    if (r.capture && r.capture.systemLevel() !== null) watchSystemAudio(r);
    // Keeps elapsed time, listening time and recording length current.
    r.autosave = setInterval(() => {
      usageLog.accrueListening(r);
      saver.markDirty(sess);
    }, 5000);
    requestWakeLock();
  } catch (err) {
    if (run !== r) return;
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    toast(denied ? t('toast.permissionNeeded') : errorText(err), 10000, 'critical');
    stop();
  }
}

// PC audio that never delivers a sample fails silently (on macOS this is what a missing
// "System Audio Recording" permission looks like), so say so instead of just showing nothing.
function watchSystemAudio(r) {
  const since = Date.now();
  r.systemWatch = setInterval(() => {
    if (r.capture.systemLevel() > 0) return clearInterval(r.systemWatch);
    if (Date.now() - since < SILENT_SYSTEM_AUDIO_MS) return;
    clearInterval(r.systemWatch);
    toast(t(inMacDesktopApp() ? 'toast.systemAudioSilentMac' : 'toast.systemAudioSilent'), 20000, 'warning');
  }, 1000);
}

function startRecording(r) {
  const sess = r.session;
  const rec = { id: uid(), startedAt: r.startedAt, elapsedStart: r.baseMs, durationMs: 0, mime: '' };
  try {
    r.recorder = new Recorder(r.capture.stream, (blob) => {
      store.addAudioChunk(sess.id, rec.id, blob).catch(() => {
        if (!r.recordWarned) toast(t('toast.recordSaveFailed'), 6000, 'warning');
        r.recordWarned = true;
      });
    });
    rec.mime = r.recorder.mime;
    r.recorder.start();
    r.recording = rec;
    sess.recordings.push(rec);
    saver.markDirty(sess);
  } catch {
    toast(t('toast.recordUnsupported'), 6000, 'warning');
  }
}

function stop() {
  const r = run;
  if (!r) return;
  usageLog.accrueListening(r);
  r.listeningSince = 0;
  r.transcriber?.stop();
  reader.stop();
  r.tracker.flush(); // keep whatever was heard so far instead of dropping it
  flow.dropLive();
  view.trimCaptions(0);
  r.pacer.cancel();
  clearInterval(r.ticker);
  clearInterval(r.systemWatch);
  clearInterval(r.autosave);
  if (r.startedAt) r.session.activeMs = elapsedNow();
  if (r.recording) r.recording.durationMs = Date.now() - r.recording.startedAt;
  if (r.trace) {
    r.trace.end();
    lastTrace = r.trace.toJSON();
  }
  run = null;
  // Let the recorder hand over its last chunk before the audio graph is torn down.
  const release = () => r.capture?.stop();
  if (r.recorder) r.recorder.stop().then(release, release);
  else release();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  setRunning(false);
  els.clock.textContent = formatElapsed(r.session.activeMs);
  saver.markDirty(r.session);
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* unsupported or denied */
  }
}
document.addEventListener('visibilitychange', () => {
  if (run && document.visibilityState === 'visible') requestWakeLock();
});

// ---------- transcript + translation flow ----------
// From the segmenter's results to translations on the page and read aloud (src/translation/flow.js).
const flow = createFlow({
  view,
  reader,
  settings,
  getRun: () => run,
  selectedLangs: () => selectedLangs(settings),
  platform: appPlatform(),
  markDirty: saver.markDirty,
  errorText,
  onRateLimit: () => toast(t('toast.rateLimited'), 6000, 'warning'),
  uid,
  elapsedNow,
  strategy: PACER,
});

// ---------- startup ----------
setStatus('idle');
els.toggle.textContent = t('toggle.start');
// Until that window is closed the list below stays empty, so say why.
store.onUpgradeBlocked(() => toast(t('toast.upgradeBlocked'), 60_000, 'warning'));
try {
  sessions = (await store.listSessions()).sort((a, b) => b.createdAt - a.createdAt);
} catch {
  toast(t('toast.storageUnavailable'), 6000, 'warning');
}
let lastId = null;
try {
  lastId = localStorage.getItem('rt-current');
} catch {
  /* private mode */
}
// The main button and the controls that act on the current session (download, summary, speaker
// labels) are disabled in the HTML until there is a session: a press that came earlier (a click or
// a global shortcut right after opening) would find none. None of them is disabled for another
// reason; they are shown or hidden by the panels' own render functions, which have run by now.
try {
  await showSession(sessions.find((x) => x.id === lastId) ?? blankSession());
} finally {
  if (!current) await showSession(blankSession());
  for (const el of [
    els.toggle,
    els.export,
    els.exportTranscript,
    els.summarize,
    els.summaryCopy,
    els.summaryDownload,
    els.summaryDelete,
    els.labelSpeakers,
    els.editSpeakers,
    els.speakerSave,
  ])
    el.disabled = false;
}
if (MOCK) toast(t('toast.demo'), 4000);
updateNotice.start(); // not awaited: the app does not wait for GitHub
