import { addFileSourceOption, FILE_TAIL_MS, pickAudioFile, traceDownloadButton } from './debug/debug-tools.js';
import { MockTranscriber, MockTranslator } from './debug/mock.js';
import { createTrace } from './debug/trace.js';
import { MODEL as DIARIZE_MODEL } from './session/diarizer.js';
import { formatElapsed } from './session/exporter.js';
import { createSessionSaver, isEmpty, blankSession as newSession } from './session/session-save.js';
import { hasLabels } from './session/speaker-labels.js';
import { AudioCapture, canCaptureSystemAudio, inMacDesktopApp } from './speech/audio.js';
import { canRecord, Recorder } from './speech/recorder.js';
import { GeminiLiveTranscriber } from './speech/transcriber.js';
import { applyReplacements, parseVocabulary } from './speech/vocabulary.js';
import { loadApiKey, saveApiKey } from './storage/secrets.js';
import { DEFAULTS, loadSettings, normalizeSettings, saveSettings as writeSettings } from './storage/settings.js';
import { store } from './storage/store.js';
import { createFlow } from './translation/flow.js';
import { DEFAULT_STRATEGY, strategyNamed } from './translation/pacer.js';
import { ReadAloud, readAloudLanguages } from './translation/read-aloud.js';
import { scriptsDiffer } from './translation/script-hint.js';
import { GeminiTranslator } from './translation/translator.js';
import { createCaptionWindow } from './ui/caption-window.js';
import { createExportDialog } from './ui/export-dialog.js';
import { applyTranslations, availableLocales, getLocale, resolveLocale, setLocale, t } from './ui/i18n.js';
import { octicon } from './ui/icons.js';
import { followPlace, LANGS, langLabel as labelIn } from './ui/langs.js';
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

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  [
    'langA',
    'langB',
    'langC',
    'swap',
    'source',
    'export',
    'openSettings',
    'menu',
    'backdrop',
    'newSession',
    'sessionList',
    'clock',
    'jump',
    'now',
    'nowList',
    'pip',
    'exportDialog',
    'exportFormat',
    'exportContent',
    'exportTranscript',
    'recordings',
    'record',
    'log',
    'empty',
    'anchor',
    'toast',
    'dot',
    'statusText',
    'level',
    'toggle',
    'settings',
    'apiKey',
    'apiKeyStorage',
    'translateModel',
    'interimTranslate',
    'smart',
    'glossary',
    'vocabulary',
    'fontSize',
    'otherInto',
    'otherIntoField',
    'readAloud',
    'readAloudField',
    'readAloudUnavailable',
    'captionItems',
    'captionItemsOut',
    'captionContent',
    'captionFontSize',
    'captionFontSizeOut',
    'captionFontSizeField',
    'captionOpacity',
    'captionOpacityOut',
    'captionOpacityField',
    'clickThrough',
    'clickThroughField',
    'captionDesktopOnly',
    'shortcutsGroup',
    'shortcutList',
    'globalShortcuts',
    'updatesGroup',
    'checkUpdates',
    'updateNotice',
    'updateText',
    'updateOpen',
    'updateDismiss',
    'interimInterval',
    'interimIntervalOut',
    'settingsRunning',
    'uiLang',
    'summary',
    'summaryToggle',
    'summaryStale',
    'summaryMeta',
    'summaryStatus',
    'summarize',
    'summaryTemplate',
    'summaryLength',
    'summaryLanguage',
    'summaryBody',
    'summaryHistoryBar',
    'summaryHistory',
    'summaryCopy',
    'summaryDownload',
    'summaryDelete',
    'summaryDetails',
    'summaryTruncated',
    'summaryContent',
    'speakerTools',
    'speakersStatus',
    'labelSpeakers',
    'editSpeakers',
    'cancelSpeakers',
    'speakerDialog',
    'speakerLine',
    'speakerLineText',
    'speakerLineSelect',
    'speakerNames',
    'speakerUncertain',
    'speakerNote',
    'speakerSave',
    'templateList',
    'templateNew',
    'templateImport',
    'templateImportFile',
    'templateExport',
    'templateStatus',
    'templateEditor',
    'templateEditorTitle',
    'templateName',
    'templateDescription',
    'templatePrompt',
    'templateError',
    'templateSave',
    'templateCancel',
    'openUsage',
    'usageDialog',
    'usageSessionNote',
    'usageSessionWrap',
    'usageSession',
    'usageTotals',
    'usageSessions',
    'usageUnpriced',
    'usageNote',
    'pricesGroup',
    'priceFields',
    'pricesError',
    'pricesReset',
  ].map((id) => [id, $(id)]),
);

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
let { key: apiKey, storage: keyStorage } = await loadApiKey(window.secretStore, legacyKey);
if (legacyKey !== undefined) saveSettings();
// The caption zone keeps its own settings while a third language is selected (see DEFAULTS in settings.js).
const captionKey = (name) => (settings.langC ? `${name}3` : name);
const reader = new ReadAloud(); // reads finished translations aloud
let captionWindow = null; // the caption window part (src/ui/caption-window.js), made in its section below
let languageNames = null; // Intl.DisplayNames for the UI language

// ---------- UI language ----------
function applyLocale() {
  setLocale(resolveLocale(settings.uiLang, navigator.languages));
  try {
    languageNames = new Intl.DisplayNames([getLocale()], { type: 'language' });
  } catch {
    languageNames = null;
  }
  applyTranslations(document);
  els.nowList.dataset.empty = t('now.empty');
}
const langLabel = (code) => labelIn(code, languageNames);
// Re-renders everything on screen that is not static markup.
function relocalize() {
  applyLocale();
  for (const sel of [els.langA, els.langB, els.langC])
    for (const o of sel.options) o.text = o.value ? langLabel(o.value) : t('header.langC.none');
  els.uiLang.options[0].text = t('settings.uiLang.auto');
  fillOtherInto();
  fillReadAloud();
  showTuning();
  showKeyStorage();
  setStatus(statusState);
  els.toggle.textContent = t(run ? 'toggle.stop' : 'toggle.start');
  renderSidebar();
  fillSummaryTemplates();
  renderTemplateList();
  renderSummary();
  renderSpeakers();
  renderShortcuts();
  showUpdateNotice();
  if (els.settings.open) renderPriceFields();
  if (els.usageDialog.open) renderUsage();
  captionWindow.relocalize();
}
applyLocale();
els.uiLang.add(new Option(t('settings.uiLang.auto'), 'auto'));
for (const l of availableLocales()) els.uiLang.add(new Option(l.name, l.id));
if (!availableLocales().some((l) => l.id === settings.uiLang)) settings.uiLang = 'auto';
els.uiLang.onchange = () => {
  settings.uiLang = els.uiLang.value;
  saveSettings();
  relocalize();
};
window.addEventListener('languagechange', () => {
  if (settings.uiLang === 'auto') relocalize();
});

for (const sel of [els.langA, els.langB]) {
  for (const l of LANGS) sel.add(new Option(langLabel(l.code), l.code));
}
els.langC.add(new Option(t('header.langC.none'), ''));
for (const l of LANGS) els.langC.add(new Option(langLabel(l.code), l.code));
els.langA.value = settings.langA;
els.langB.value = settings.langB;
normalizeSettings(settings); // a stored third language or choice for other languages that no longer fits
els.langC.value = settings.langC;
if (!canCaptureSystemAudio()) {
  for (const option of els.source.querySelectorAll('option:not([value=mic])')) option.remove();
  settings.source = 'mic';
}
if (DEBUG) addFileSourceOption(els.source);
else if (settings.source === 'file') settings.source = 'mic';
els.source.value = settings.source;
applyFontSize();

// The caption window has its own text size; the main window's applies to everything else.
function applyFontSize() {
  document.documentElement.style.setProperty('--fs', `${settings.fontSize}px`);
  captionWindow?.fontSize();
}
function onLangChange(changed, other) {
  if (changed.value === other.value) other.value = changed === els.langA ? settings.langB : settings.langA;
  if (changed.value === other.value) other.value = LANGS.find((l) => l.code !== changed.value).code;
  // The third language never equals the first two: it takes the language the changed one had,
  // or is turned off when that is taken too.
  const third = els.langC;
  if (third.value && (third.value === els.langA.value || third.value === els.langB.value)) {
    const previous = settings[changed.id];
    third.value = langsInUse().includes(previous) ? '' : previous;
  }
  langsChanged();
}
const langsInUse = () => [els.langA.value, els.langB.value, els.langC.value];
// A third language that equals one of the first two takes its place there; that one gets the
// third language's previous value, or the first language not in use when there was none.
function onThirdLangChange() {
  const third = els.langC;
  for (const sel of [els.langA, els.langB]) {
    if (!third.value || sel.value !== third.value) continue;
    const previous = settings.langC;
    sel.value =
      previous && !langsInUse().includes(previous) ? previous : LANGS.find((l) => !langsInUse().includes(l.code)).code;
  }
  langsChanged();
}
// The choices for another language and for reading aloud are stored as a place (A / B / C) but
// mean a language, so they follow that language when it changes places. A choice of the third
// language that is turned off becomes 'all' for other languages and 'off' for reading aloud.
function setLangs(a, b, c) {
  const was = { A: settings.langA, B: settings.langB, C: settings.langC };
  const now = { A: a, B: b, C: c };
  settings.otherInto = followPlace(settings.otherInto, was, now, 'all');
  settings.readAloud = followPlace(settings.readAloud, was, now, 'off');
  Object.assign(settings, { langA: a, langB: b, langC: c });
}
function langsChanged() {
  setLangs(els.langA.value, els.langB.value, els.langC.value);
  saveSettings();
  applyCaptionOptions();
  if (current) {
    current.langA = settings.langA;
    current.langB = settings.langB;
    setSessionLangC(current);
    markDirty(current);
  }
}
// A session with two languages keeps the shape it always had: no langC at all.
function setSessionLangC(sess) {
  if (settings.langC) sess.langC = settings.langC;
  else delete sess.langC;
}
els.langA.onchange = () => onLangChange(els.langA, els.langB);
els.langB.onchange = () => onLangChange(els.langB, els.langA);
els.langC.onchange = onThirdLangChange;
els.swap.onclick = () => {
  [els.langA.value, els.langB.value] = [els.langB.value, els.langA.value];
  langsChanged();
};
els.source.onchange = () => {
  settings.source = els.source.value;
  saveSettings();
};

els.openSettings.onclick = openSettings;
function openSettings() {
  els.apiKey.value = apiKey;
  showKeyStorage();
  els.translateModel.value = settings.translateModel;
  els.interimTranslate.checked = settings.interimTranslate;
  els.smart.checked = settings.smart;
  els.record.checked = settings.record;
  els.glossary.value = settings.glossary;
  els.vocabulary.value = settings.vocabulary;
  els.fontSize.value = settings.fontSize;
  els.uiLang.value = settings.uiLang;
  fillOtherInto();
  els.otherInto.value = settings.otherInto;
  fillReadAloud();
  els.captionItems.value = settings[captionKey('captionItems')];
  els.interimInterval.value = settings.interimInterval;
  els.captionContent.value = settings[captionKey('captionContent')];
  els.captionFontSize.value = settings.captionFontSize;
  els.captionOpacity.value = settings.captionOpacity;
  els.clickThrough.checked = settings.clickThrough;
  els.checkUpdates.checked = settings.checkUpdates;
  showCaptionControls();
  showTuning();
  showShortcuts();
  closeTemplateEditor();
  els.templateStatus.hidden = true;
  renderTemplateList();
  openPriceFields();
  els.settingsRunning.hidden = !run;
  els.settings.showModal();
}
function showKeyStorage() {
  els.apiKeyStorage.textContent = t(`settings.apiKey.storage.${keyStorage}`);
}
// All selected languages, or one of them (the third only while there is one). A choice not yet
// saved survives a change of display language.
function fillOtherInto() {
  const value = els.otherInto.value || settings.otherInto;
  const sides = settings.langC ? ['A', 'B', 'C'] : ['A', 'B'];
  els.otherInto.replaceChildren(
    new Option(t('settings.otherInto.all'), 'all'),
    ...sides.map((s) => new Option(t('settings.otherInto.only', { lang: langLabel(settings[`lang${s}`]) }), s)),
  );
  els.otherInto.value = value;
  if (!els.otherInto.value) els.otherInto.value = 'all';
}
// With two languages, reading aloud needs the language of each translation, which only the writing
// system tells. With three, each translation line is requested into a known language.
const canReadAloudPair = () =>
  scriptsDiffer(LANGS.find((l) => l.code === settings.langA).name, LANGS.find((l) => l.code === settings.langB).name);
const selectedLangs = () => [settings.langA, settings.langB, settings.langC].filter(Boolean);
// Off, one choice per selected language, and both directions with two languages only. A stored
// choice that does not fit the languages selected shows as Off.
function fillReadAloud() {
  els.readAloudField.hidden = !reader.available;
  const three = !!settings.langC;
  const sides = three ? ['A', 'B', 'C'] : ['A', 'B'];
  els.readAloud.replaceChildren(
    new Option(t('settings.readAloud.off'), 'off'),
    ...sides.map((s) => new Option(t('settings.readAloud.into', { lang: langLabel(settings[`lang${s}`]) }), s)),
    ...(three ? [] : [new Option(t('settings.readAloud.both'), 'both')]),
  );
  els.readAloud.value = readAloudLanguages(settings.readAloud, selectedLangs()).length ? settings.readAloud : 'off';
  const pair = three || canReadAloudPair();
  els.readAloud.disabled = !pair;
  els.readAloudUnavailable.hidden = pair;
}
// Applies at once, also while listening.
els.readAloud.onchange = () => {
  settings.readAloud = els.readAloud.value;
  if (settings.readAloud === 'off') reader.stop();
  saveSettings();
};
els.fontSize.oninput = () => {
  settings.fontSize = Number(els.fontSize.value);
  applyFontSize();
};
// These apply immediately, so they can be tuned while listening.
function showTuning() {
  const n = Number(els.captionItems.value);
  const form = new Intl.PluralRules(getLocale()).select(n) === 'one' ? 'one' : 'other';
  els.captionItemsOut.textContent = t(`settings.captionItems.${form}`, { n });
  els.interimIntervalOut.textContent = t('settings.interimInterval.value', {
    s: Number(els.interimInterval.value).toFixed(1),
  });
  els.captionFontSizeOut.textContent = t('settings.captionFontSize.value', { n: Number(els.captionFontSize.value) });
  els.captionOpacityOut.textContent = t('settings.captionOpacity.value', { n: Number(els.captionOpacity.value) });
}
els.captionItems.oninput = () => {
  settings[captionKey('captionItems')] = Number(els.captionItems.value);
  showTuning();
  trimCaptions();
};
els.interimInterval.oninput = () => {
  settings.interimInterval = Number(els.interimInterval.value);
  showTuning();
};
els.captionContent.onchange = () => {
  settings[captionKey('captionContent')] = els.captionContent.value;
  applyCaptionOptions();
};
els.captionFontSize.oninput = () => {
  settings.captionFontSize = Number(els.captionFontSize.value);
  showTuning();
  applyFontSize();
};
els.captionOpacity.oninput = () => {
  settings.captionOpacity = Number(els.captionOpacity.value);
  showTuning();
  applyCaptionOptions();
};
els.clickThrough.onchange = () => {
  settings.clickThrough = els.clickThrough.checked;
  applyClickThrough();
};
els.globalShortcuts.onchange = async () => {
  settings.globalShortcuts = els.globalShortcuts.checked;
  await applyGlobalShortcuts();
};
els.settings.addEventListener('close', () => {
  const key = els.apiKey.value.trim();
  if (key !== apiKey) {
    apiKey = key;
    saveApiKey(window.secretStore, key).then((storage) => {
      keyStorage = storage;
      showKeyStorage();
    });
  }
  settings.translateModel = els.translateModel.value.trim() || DEFAULTS.translateModel;
  settings.interimTranslate = els.interimTranslate.checked;
  settings.smart = els.smart.checked;
  settings.record = els.record.checked;
  settings.glossary = els.glossary.value.trim();
  settings.vocabulary = els.vocabulary.value.trim();
  settings.fontSize = Number(els.fontSize.value);
  settings.otherInto = els.otherInto.value;
  // The caption zone's sentences and content are stored as they change (they belong to the
  // number of languages the dialog was opened with, which may have changed by now).
  settings.interimInterval = Number(els.interimInterval.value);
  settings.captionFontSize = Number(els.captionFontSize.value);
  settings.captionOpacity = Number(els.captionOpacity.value);
  settings.clickThrough = els.clickThrough.checked;
  if (window.appShortcuts) settings.globalShortcuts = els.globalShortcuts.checked;
  if (window.appUpdates) settings.checkUpdates = els.checkUpdates.checked;
  const prices = pendingOverrides();
  if (prices) settings.priceOverrides = prices; // invalid prices keep the ones saved before
  saveSettings();
  checkForUpdates(); // turned on: asks if it is time; turned off: hides the notice
});

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
  onFlushed: renderSidebar,
  onSaveFailed: (err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'),
});
function markDirty(sess) {
  saver.markDirty(sess);
}
function flushSaves() {
  saver.flushSaves();
}
window.addEventListener('pagehide', flushSaves);

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
  for (const seg of sess.segments) mountSegment(seg);
  els.empty.hidden = sess.segments.length > 0;
  const [a, b] =
    LANGS.some((l) => l.code === sess.langA) && LANGS.some((l) => l.code === sess.langB) && sess.langA !== sess.langB
      ? [sess.langA, sess.langB]
      : [settings.langA, settings.langB];
  const langC = sess.langC;
  setLangs(a, b, LANGS.some((l) => l.code === langC) && langC !== a && langC !== b ? langC : '');
  els.langA.value = settings.langA;
  els.langB.value = settings.langB;
  els.langC.value = settings.langC;
  saveSettings();
  applyCaptionOptions();
  els.clock.textContent = formatElapsed(sess.activeMs);
  els.log.scrollTop = els.log.scrollHeight;
  document.body.classList.remove('drawer');
  renderSidebar();
  renderSummary();
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
  markDirty,
});
function renderSidebar() {
  sidebar.render();
}

// ---------- transcript view ----------
// The segments on the page and the code that leads each line (src/ui/transcript-view.js).
const view = createTranscriptView({
  els,
  settings,
  getCurrent: () => current,
  getRun: () => run,
  captionKey,
  langLabel,
  showSpeaker,
  openSpeakerEditor,
});
// Builds the DOM for a segment (new or loaded from storage) and attaches it to the segment object.
function mountSegment(seg, isLive = false) {
  return view.mount(seg, isLive);
}
// Moves the oldest sentences out of the caption zone into the transcript.
function trimCaptions(keep) {
  view.trimCaptions(keep);
}

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
  applyFontSize,
});
function applyCaptionOptions() {
  captionWindow.applyOptions();
}
function applyClickThrough() {
  captionWindow.applyClickThrough();
}
function showCaptionControls() {
  captionWindow.showControls();
}

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
function renderShortcuts() {
  shortcutsPanel.render();
}
function showShortcuts() {
  return shortcutsPanel.show();
}
function applyGlobalShortcuts() {
  return shortcutsPanel.apply();
}

// ---------- newer versions (desktop app) ----------
// The notice of a newer version, and when to ask for one (src/ui/update-notice.js).
const updateNotice = createUpdateNotice({ els, t, settings, storage: browserStorage, bridge: () => window.appUpdates });
function showUpdateNotice() {
  updateNotice.show();
}
function checkForUpdates() {
  return updateNotice.check();
}
function startUpdateChecks() {
  return updateNotice.start();
}

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
  flushSaves,
  getTrace: () => (DEBUG ? lastTrace : null),
  traceButton: (trace) => traceDownloadButton(trace, download),
  summariesOf,
  speakerName,
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
  getApiKey: () => apiKey,
  openSettings,
  markDirty,
  recordUsage,
  speakerName,
  renderSpeakerTools,
  mock: MOCK,
});
// The session's summaries, oldest first.
function summariesOf(sess) {
  return summaryPanel.summariesOf(sess);
}
function renderSummary() {
  summaryPanel.render();
}
function fillSummaryTemplates() {
  summaryPanel.fillTemplates();
}

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
  getApiKey: () => apiKey,
  openSettings,
  flushSaves,
  markDirty,
  recordUsage,
  renderSummary,
  debug: DEBUG,
});
// The name shown for a speaker id of `sess`, or '' for none.
function speakerName(sess, id) {
  return speakerPanel.speakerName(sess, id);
}
function showSpeaker(seg) {
  speakerPanel.showSpeaker(seg);
}
function renderSpeakers() {
  speakerPanel.render();
}
function renderSpeakerTools() {
  speakerPanel.renderTools();
}
function openSpeakerEditor(seg) {
  speakerPanel.openEditor(seg);
}

// ---------- summary templates (settings dialog) ----------
const templateEditor = createTemplateEditor({
  els,
  t,
  octicon,
  templates,
  uid,
  errorText,
  download,
  onTemplatesChanged: () => fillSummaryTemplates(),
});
function renderTemplateList() {
  templateEditor.renderList();
}
function closeTemplateEditor() {
  templateEditor.close();
}

// ---------- usage and cost estimates ----------
// What each session used and the daily totals (src/usage/usage-log.js), the usage dialog and the price
// fields in the settings (src/ui/usage-dialog.js). In the demo mode the made-up usage goes into its
// session only.
const usageLog = createUsageLog({
  settings,
  storage: browserStorage,
  demo: MOCK,
  isEmpty,
  markDirty,
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
// Adds `usage`, what one request or a stretch of listening used, to `sess` and to the totals.
function recordUsage(sess, usage) {
  usageLog.recordUsage(sess, usage);
}
// Listening time counts while the recognizer is connected (state 'listening').
function accrueListening(r) {
  usageLog.accrueListening(r);
}
function renderUsage() {
  usageDialog.render();
}
function openPriceFields() {
  usageDialog.openPriceFields();
}
function renderPriceFields() {
  usageDialog.renderPriceFields();
}
// The overrides the price fields describe, or null while any of them is not a price.
function pendingOverrides() {
  return usageDialog.pendingOverrides();
}

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
  renderSummary();
}

els.toggle.onclick = () => (run ? stop() : start());

async function start() {
  if (!MOCK && !apiKey) {
    window.appShortcuts?.focusApp().catch(() => {}); // when started by a shortcut from another app
    toast(t('toast.apiKeyFirst'), 6000, 'warning');
    return openSettings();
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
      accrueListening(r);
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
    recordUsage(sess, addTokens(emptyUsage(), 'translation', model, usageMetadata));
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
      accrueListening(r);
      markDirty(sess);
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
    markDirty(sess);
  } catch {
    toast(t('toast.recordUnsupported'), 6000, 'warning');
  }
}

function stop() {
  const r = run;
  if (!r) return;
  accrueListening(r);
  r.listeningSince = 0;
  r.transcriber?.stop();
  reader.stop();
  r.tracker.flush(); // keep whatever was heard so far instead of dropping it
  flow.dropLive();
  trimCaptions(0);
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
  markDirty(r.session);
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
  selectedLangs,
  markDirty,
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
startUpdateChecks(); // not awaited: the app does not wait for GitHub
