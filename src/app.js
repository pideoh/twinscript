import { AudioCapture, canCaptureSystemAudio, inMacDesktopApp } from './audio.js';
import { addFileSourceOption, FILE_TAIL_MS, pickAudioFile, traceDownloadButton } from './debug-tools.js';
import { buildTranscript, formatDateTime, formatElapsed, safeFileName } from './exporter.js';
import { applyTranslations, availableLocales, getLocale, resolveLocale, setLocale, t } from './i18n.js';
import { octicon } from './icons.js';
import { MessageError } from './message-error.js';
import { MockSummarizer, MockTranscriber, MockTranslator } from './mock.js';
import { createPacer, DEFAULT_STRATEGY, strategyNamed } from './pacer.js';
import { ReadAloud } from './read-aloud.js';
import { canRecord, Recorder } from './recorder.js';
import { languageByScript, scriptsDiffer, sourceByScript, targetLanguages } from './script-hint.js';
import { loadApiKey, saveApiKey } from './secrets.js';
import { UtteranceTracker } from './segmenter.js';
import { store } from './store.js';
import { GeminiSummarizer } from './summarizer.js';
import { createTrace } from './trace.js';
import { GeminiLiveTranscriber } from './transcriber.js';
import { GeminiTranslator, RateLimitError } from './translator.js';
import { applyReplacements, parseVocabulary } from './vocabulary.js';

// code: what the recognizer is told; display: the tag whose name is shown in the UI language
// (no region, but the script for Chinese); name: what the translation prompt says.
const LANGS = [
  { code: 'ja-JP', display: 'ja', name: 'Japanese' },
  { code: 'en-US', display: 'en', name: 'English' },
  { code: 'cmn-Hans-CN', display: 'zh-Hans', name: 'Simplified Chinese' },
  { code: 'cmn-Hant-TW', display: 'zh-Hant', name: 'Traditional Chinese' },
  { code: 'ko-KR', display: 'ko', name: 'Korean' },
  { code: 'es-ES', display: 'es', name: 'Spanish' },
  { code: 'fr-FR', display: 'fr', name: 'French' },
  { code: 'de-DE', display: 'de', name: 'German' },
  { code: 'it-IT', display: 'it', name: 'Italian' },
  { code: 'pt-BR', display: 'pt', name: 'Portuguese' },
  { code: 'vi-VN', display: 'vi', name: 'Vietnamese' },
  { code: 'th-TH', display: 'th', name: 'Thai' },
  { code: 'id-ID', display: 'id', name: 'Indonesian' },
  { code: 'hi-IN', display: 'hi', name: 'Hindi' },
];
const DEFAULTS = {
  langA: 'ja-JP',
  langB: 'en-US',
  langC: '', // an optional third language: every sentence is then translated into the other two
  source: 'mic',
  uiLang: 'auto',
  translateModel: 'gemini-3.5-flash-lite',
  interimTranslate: true,
  smart: false,
  record: true,
  glossary: '',
  vocabulary: '', // terms for the recognizer and `wrong => right` corrections, one per line
  fontSize: 18,
  // Speech in none of the selected languages goes into all of them ('all') or only into the one
  // in that place ('A', 'B' or 'C').
  otherInto: 'all',
  readAloud: 'off', // 'off', 'A', 'B' or 'both': translations into which language are read aloud
  captionItems: 3, // sentences kept in the caption zone, including the one being spoken
  captionContent: 'both', // 'both' or 'tgt' (translation only) in the caption zone
  // The same two with a third language, remembered apart. Translations only, so a sentence takes
  // two lines there as well; fewer sentences would be replaced before they can be read.
  captionItems3: 3,
  captionContent3: 'tgt',
  captionFontSize: 20, // text size while the caption zone is in the caption window
  captionOpacity: 90, // background of the desktop caption overlay, in percent
  clickThrough: false, // desktop caption overlay: mouse events go to the app underneath
  globalShortcuts: true, // desktop app: start / stop and the caption window from any app
  interimInterval: 1.5, // seconds between re-translations of the sentence being spoken
};
const HISTORY_LINES = 3;
const SILENT_SYSTEM_AUDIO_MS = 8000; // how long PC audio may deliver nothing before the user is told
const MOCK = new URLSearchParams(location.search).has('mock');
const DEBUG = new URLSearchParams(location.search).has('debug'); // log raw recognizer output to the console
// Debug only: the recognizer trace of the last run (src/trace.js), also readable from the console.
let lastTrace = null;
if (DEBUG) window.__twinscriptTrace = () => lastTrace;
// Debug only: ?pacer=<name> picks the pacing strategy of src/pacer.js for this page load.
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
    'readAloudUnavailableThree',
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
    'summarizeLabel',
    'summaryBody',
    'summaryTruncated',
    'summaryContent',
  ].map((id) => [id, $(id)]),
);

// ---------- settings ----------
// Returns the known settings only, plus the API key an earlier version kept in the same JSON.
function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('rt-settings') || '{}') ?? {};
  } catch {
    /* unreadable: start from the defaults */
  }
  const known = Object.fromEntries(Object.keys(DEFAULTS).map((name) => [name, stored[name] ?? DEFAULTS[name]]));
  return { settings: known, legacyKey: typeof stored.apiKey === 'string' ? stored.apiKey : undefined };
}
// The API key is not part of the settings: it is never written to localStorage (see secrets.js).
function saveSettings() {
  try {
    localStorage.setItem('rt-settings', JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}
// Earlier versions kept the key in the settings JSON: move it out and rewrite the JSON without it.
const { settings, legacyKey } = loadSettings();
let { key: apiKey, storage: keyStorage } = await loadApiKey(window.secretStore, legacyKey);
if (legacyKey !== undefined) saveSettings();
// The caption zone keeps its own settings while a third language is selected (see DEFAULTS).
const captionKey = (name) => (settings.langC ? `${name}3` : name);
const reader = new ReadAloud(); // reads finished translations aloud
let captionWindow = null; // always-on-top caption window, when open
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
const langLabel = (code) => {
  const l = LANGS.find((x) => x.code === code);
  if (!l) return code;
  try {
    return languageNames?.of(l.display) ?? l.name;
  } catch {
    return l.name;
  }
};
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
  renderSummary();
  renderShortcuts();
  if (captionWindow) {
    applyTranslations(captionWindow.document); // the caption zone lives there while it is open
    captionWindow.document.title = t('caption.title');
    const close = captionWindow.document.querySelector('.overlay-close');
    if (close) {
      close.title = t('caption.close');
      close.setAttribute('aria-label', close.title);
    }
  }
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
if (!LANGS.some((l) => l.code === settings.langC) || [settings.langA, settings.langB].includes(settings.langC))
  settings.langC = '';
els.langC.value = settings.langC;
if (!['all', 'A', 'B', 'C'].includes(settings.otherInto) || (settings.otherInto === 'C' && !settings.langC))
  settings.otherInto = 'all';
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
  captionWindow?.document.documentElement.style.setProperty('--fs', `${settings.captionFontSize}px`);
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
// language that is turned off becomes 'all'.
function setLangs(a, b, c) {
  const was = { A: settings.langA, B: settings.langB, C: settings.langC };
  const now = { A: a, B: b, C: c };
  const follow = (side, sides) =>
    sides.includes(side) && was[side] ? (sides.find((s) => now[s] === was[side]) ?? side) : side;
  settings.otherInto = follow(settings.otherInto, ['A', 'B', 'C']);
  if (settings.otherInto === 'C' && !c) settings.otherInto = 'all';
  settings.readAloud = follow(settings.readAloud, ['A', 'B']);
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
  showCaptionControls();
  showTuning();
  showShortcuts();
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
// Reading aloud needs the language of each translation, which only the writing system tells.
const canReadAloudPair = () =>
  scriptsDiffer(LANGS.find((l) => l.code === settings.langA).name, LANGS.find((l) => l.code === settings.langB).name);
function fillReadAloud() {
  els.readAloudField.hidden = !reader.available;
  els.readAloud.options[1].text = t('settings.readAloud.into', { lang: langLabel(settings.langA) });
  els.readAloud.options[2].text = t('settings.readAloud.into', { lang: langLabel(settings.langB) });
  els.readAloud.value = settings.readAloud;
  // Reading aloud is for two languages only.
  const three = !!settings.langC;
  const pair = canReadAloudPair();
  els.readAloud.disabled = three || !pair;
  els.readAloudUnavailable.hidden = three || pair;
  els.readAloudUnavailableThree.hidden = !three;
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
  saveSettings();
});

// ---------- sessions (saved conversations) ----------
// { id, title, customTitle, createdAt, updatedAt, langA, langB, langC?, activeMs,
//   segments: [{ id, at, elapsed, src, tgt, lang?, tgts? }], recordings: [{ id, startedAt, elapsedStart, durationMs, mime }],
//   summary?: { overview, keyPoints, decisions, actionItems: [{ task, owner, due }], truncated,
//               generatedAt, model, segmentCount } }
// With a third language (langC), a segment also has `lang`, the code of the language it was
// spoken in ('other' for none of the three), and `tgts: [{ lang, text }]`, one translation per
// target language; `tgt` then holds those translations joined by line breaks, so everything that
// reads `tgt` works as with two languages.
let sessions = []; // saved sessions, newest first
let current = null; // the session on screen
let run = null; // the live capture/translation in progress, if any
let live = null; // segment currently being spoken
let toastTimer;
const dirty = new Set();
let saveTimer;

// randomUUID needs a secure context; the fallback takes 128 bits from the same CSPRNG.
const uid = () =>
  crypto.randomUUID?.() ??
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const isEmpty = (sess) => !sess.segments.length && !sess.recordings.length;
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

function blankSession() {
  const now = Date.now();
  return {
    id: uid(),
    title: '',
    customTitle: false,
    createdAt: now,
    updatedAt: now,
    langA: settings.langA,
    langB: settings.langB,
    ...(settings.langC && { langC: settings.langC }),
    activeMs: 0,
    segments: [],
    recordings: [],
  };
}

const serialize = (sess) => ({
  ...sess,
  segments: sess.segments.map(({ id, at, elapsed, src, tgt, lang, tgts }) => ({
    id,
    at,
    elapsed,
    src,
    tgt,
    ...(lang && { lang }),
    ...(tgts && { tgts: tgts.map(({ lang, text }) => ({ lang, text })) }),
  })),
});

function markDirty(sess) {
  dirty.add(sess);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 250);
}

function flushSaves() {
  clearTimeout(saveTimer);
  for (const sess of dirty) {
    if (isEmpty(sess)) continue; // don't litter the list with untouched sessions
    if (run?.session === sess) {
      sess.activeMs = elapsedNow();
      if (run.recording) run.recording.durationMs = Date.now() - run.recording.startedAt;
    }
    sess.updatedAt = Date.now();
    if (!sess.customTitle) sess.title = sess.segments[0]?.src.slice(0, 30) || formatDateTime(sess.createdAt);
    if (!sessions.includes(sess)) {
      sessions.unshift(sess);
      store.requestPersistence();
    }
    store
      .saveSession(serialize(sess))
      .catch((err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'));
  }
  dirty.clear();
  renderSidebar();
}
window.addEventListener('pagehide', flushSaves);

function showSession(sess) {
  reader.stop();
  current = sess;
  try {
    localStorage.setItem('rt-current', sess.id);
  } catch {
    /* private mode */
  }
  for (const node of els.log.querySelectorAll('.seg')) node.remove();
  live = null;
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

function renderSidebar() {
  els.sessionList.replaceChildren(
    ...sessions.map((sess) => {
      const row = document.createElement('div');
      row.className = `session${sess === current ? ' current' : ''}`;
      const open = document.createElement('button');
      open.className = 'open';
      if (sess === current) open.setAttribute('aria-current', 'true');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = sess.title;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = t('session.when', {
        date: formatDateTime(sess.createdAt),
        duration: formatElapsed(sess.activeMs),
      });
      open.append(name, when);
      open.onclick = () => {
        if (canSwitch()) showSession(sess);
      };
      const action = (icon, title, fn) => {
        const b = document.createElement('button');
        b.className = 'act icon-btn';
        b.append(octicon(icon));
        b.title = title;
        b.setAttribute('aria-label', title);
        b.onclick = fn;
        return b;
      };
      row.append(
        open,
        action('pencil', t('session.rename'), () => renameSession(sess)),
        action('trash', t('session.delete'), () => deleteSession(sess)),
      );
      return row;
    }),
  );
}

function canSwitch() {
  if (run) toast(t('toast.stopToSwitch'), 6000, 'warning');
  return !run;
}

function renameSession(sess) {
  const title = prompt(t('session.renamePrompt'), sess.title)?.trim();
  if (!title) return;
  sess.title = title;
  sess.customTitle = true;
  markDirty(sess);
}

async function deleteSession(sess) {
  if (run?.session === sess) return toast(t('toast.stopToDelete'), 6000, 'warning');
  if (!confirm(t('session.deleteConfirm', { title: sess.title }))) return;
  dirty.delete(sess);
  sessions = sessions.filter((x) => x !== sess);
  await store
    .deleteSession(sess.id)
    .catch((err) => toast(t('toast.deleteFailed', { message: err.message }), 6000, 'critical'));
  if (sess === current) showSession(sessions[0] ?? blankSession());
  else renderSidebar();
}

els.newSession.onclick = () => {
  if (canSwitch()) showSession(blankSession());
};
els.menu.onclick = () => document.body.classList.toggle('drawer');
els.backdrop.onclick = () => document.body.classList.remove('drawer');

// ---------- transcript view ----------
function nearBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120;
}
function keepBottom(wasNear) {
  if (wasNear) els.log.scrollTop = els.log.scrollHeight;
}

// Builds the DOM for a segment (new or loaded from storage) and attaches it to the segment object.
function mountSegment(seg, isLive = false) {
  const el = document.createElement('div');
  el.className = `seg${isLive ? ' live' : ''}`;
  const timeEl = document.createElement('div');
  timeEl.className = 'time';
  timeEl.textContent = formatElapsed(seg.elapsed);
  const srcEl = document.createElement('div');
  srcEl.className = 'src';
  srcEl.textContent = seg.src;
  const tgtEl = document.createElement('div');
  tgtEl.className = `tgt${isLive ? ' pending' : ''}`;
  el.append(timeEl, srcEl, tgtEl);
  els.empty.hidden = true;
  Object.assign(seg, { el, srcEl, tgtEl });
  if (seg.tgts) {
    showTargets(seg);
    for (const { lang, text } of seg.tgts) if (text) setLine(seg, lang, text);
  } else {
    tgtEl.textContent = seg.tgt;
  }
  if (run) {
    els.nowList.append(el);
    trimCaptions();
  } else {
    els.log.insertBefore(el, els.anchor);
  }
  return seg;
}

// Moves the oldest sentences out of the caption zone into the transcript.
function trimCaptions(keep = settings[captionKey('captionItems')]) {
  const wasNear = nearBottom();
  while (els.nowList.children.length > keep) els.log.insertBefore(els.nowList.firstElementChild, els.anchor);
  keepBottom(wasNear);
  updateJump();
}

function createSegment() {
  return mountSegment({ id: uid(), at: Date.now(), elapsed: elapsedNow(), src: '', tgt: '' }, true);
}

function setText(seg, part, text, cls) {
  const wasNear = nearBottom();
  const node = part === 'src' ? seg.srcEl : seg.tgtEl;
  node.textContent = text;
  if (part === 'tgt') {
    node.className = `tgt${cls ? ` ${cls}` : ''}`;
    node.dataset.lang = cls === 'error' ? '' : singleTag(seg, text);
  }
  tagSource(seg);
  keepBottom(wasNear);
  updateJump();
}

// With a third language a segment has one line per target language, each led by a tag. A line
// appears with its first text, in the order of seg.tgts.
function showTargets(seg) {
  seg.tgtEl.className = 'tgt multi';
  seg.tgtEl.replaceChildren();
  seg.lines = new Map();
}
// Sets the languages a segment is translated into; returns false when they were already those.
function setTargets(seg, codes) {
  if (seg.tgts && seg.lines && seg.tgts.map((x) => x.lang).join() === codes.join()) return false;
  seg.tgts = codes.map((lang) => ({ lang, text: '' }));
  showTargets(seg);
  return true;
}
// The code for a segment's single translation, told from the writing system of the translation or,
// failing that, of the source (the translation is then in the other language). Empty when the two
// languages share a writing system; the space for the code is kept, so the text stays aligned.
function singleTag(seg, text) {
  const a = LANGS.find((l) => l.code === (current?.langA ?? settings.langA));
  const b = LANGS.find((l) => l.code === (current?.langB ?? settings.langB));
  if (!a || !b || !text) return '';
  const other = (name) => (name === a.name ? b.name : name === b.name ? a.name : null);
  const name = languageByScript(text, a.name, b.name) ?? other(languageByScript(seg.srcEl.textContent, a.name, b.name));
  const lang = name === a.name ? a : name === b.name ? b : null;
  return lang ? langTag(lang.code) : '';
}
// The code of the language a segment was spoken in, shown before its source text: the language
// found when it was translated, else what the writing system of the source tells, else the other
// one than a single translation's. Empty for a language that is none of the selected ones.
function tagSource(seg) {
  const langs = [current?.langA ?? settings.langA, current?.langB ?? settings.langB, current?.langC ?? '']
    .map((code) => LANGS.find((l) => l.code === code))
    .filter(Boolean);
  const byName = (name) => langs.find((l) => l.name === name);
  const text = seg.srcEl.textContent;
  let lang = seg.lang ? langs.find((l) => l.code === seg.lang) : null;
  if (!lang && !seg.lang && text) {
    lang = byName(
      sourceByScript(
        text,
        langs.map((l) => l.name),
      ),
    );
    if (!lang && langs.length === 2 && !seg.lines) {
      const tgt = languageByScript(seg.tgtEl.textContent, langs[0].name, langs[1].name);
      if (tgt) lang = langs.find((l) => l.name !== tgt);
    }
  }
  seg.srcEl.dataset.lang = lang ? langTag(lang.code) : '';
}
// The short code that leads a translation line: "EN", "JA", "ZH". All tags have the same width,
// so the translations start at the same place. Two selected languages that share the code
// (Simplified and Traditional Chinese) keep their full one.
function langTag(code) {
  const display = LANGS.find((l) => l.code === code)?.display ?? code;
  const short = (d) => d.split('-')[0];
  const selected = [settings.langA, settings.langB, settings.langC].filter((c) => c && c !== code);
  const clash = selected.some((c) => short(LANGS.find((l) => l.code === c)?.display ?? c) === short(display));
  return (clash ? display : short(display)).toUpperCase();
}
function setLine(seg, code, text, cls) {
  const wasNear = nearBottom();
  let line = seg.lines.get(code);
  if (!line) {
    const lang = LANGS.find((l) => l.code === code);
    line = document.createElement('div');
    const tag = document.createElement('span');
    tag.className = 'lang-tag';
    tag.textContent = langTag(code);
    if (lang) tag.title = langLabel(code);
    const body = document.createElement('span');
    body.className = 'tgt-text';
    if (lang) body.lang = lang.display;
    line.append(tag, body);
    const order = (c) => seg.tgts.findIndex((x) => x.lang === c);
    const next = [...seg.lines].find(([c]) => order(c) > order(code))?.[1];
    seg.tgtEl.insertBefore(line, next ?? null);
    seg.lines.set(code, line);
  }
  line.className = `tgt-line${cls ? ` ${cls}` : ''}`;
  line.lastChild.textContent = text;
  keepBottom(wasNear);
  updateJump();
}

// Offer a way back to the latest sentence while the user has scrolled up to re-read.
function updateJump() {
  els.jump.hidden = nearBottom();
}
els.log.addEventListener('scroll', updateJump, { passive: true });
els.jump.onclick = () => {
  els.log.scrollTop = els.log.scrollHeight;
};

// ---------- caption window ----------
// Shows the caption zone in an always-on-top window, so it can sit over a video call or slides:
// Document Picture-in-Picture in desktop Chrome and Edge, or a transparent overlay window opened
// by the desktop app (app/main.js makes the 'captions' window frameless and always on top).
const IN_DESKTOP_APP = /\bElectron\//.test(navigator.userAgent);
const CAPTION_WINDOW_NAME = 'captions'; // must match CAPTION_WINDOW in app/policy.js
els.pip.hidden = !('documentPictureInPicture' in window) && !IN_DESKTOP_APP;

// Settings of the caption zone that apply wherever it is, at once (also while listening).
function applyCaptionOptions() {
  els.now.classList.toggle('tgt-only', settings[captionKey('captionContent')] === 'tgt');
  // The desktop overlay's backdrop; a picture-in-picture window is opaque by nature.
  if (captionWindow?.document.body.classList.contains('overlay'))
    captionWindow.document.body.style.setProperty('--caption-bg-alpha', String(settings.captionOpacity / 100));
}
// The main process keeps the state and applies it to the overlay whenever it is open.
function applyClickThrough() {
  window.captionOverlay?.setClickThrough(settings.clickThrough).catch(() => {});
}
// Opacity and click-through exist only for the desktop overlay; without any caption window,
// its options are left out altogether.
function showCaptionControls() {
  const anyWindow = !els.pip.hidden;
  els.captionFontSizeField.hidden = !anyWindow;
  els.captionOpacityField.hidden = !IN_DESKTOP_APP;
  els.clickThroughField.hidden = !IN_DESKTOP_APP;
  els.captionDesktopOnly.hidden = IN_DESKTOP_APP || !anyWindow;
}
applyCaptionOptions();
if (settings.clickThrough) applyClickThrough();

// ---------- global shortcuts (desktop app) ----------
// The main process registers them (app/shortcuts.js); each one does what its button does.
let shortcutStatus = null; // { enabled, shortcuts: [{ command, label, registered }] }
els.shortcutsGroup.hidden = !window.appShortcuts;

function renderShortcuts() {
  if (!shortcutStatus) return;
  els.globalShortcuts.checked = shortcutStatus.enabled;
  els.shortcutList.replaceChildren(
    ...shortcutStatus.shortcuts.flatMap((s) => {
      const name = document.createElement('dt');
      name.textContent = t(`settings.shortcuts.${s.command}`);
      const keys = document.createElement('dd');
      const kbd = document.createElement('kbd');
      kbd.textContent = s.label;
      keys.append(kbd);
      if (shortcutStatus.enabled && !s.registered) {
        const note = document.createElement('span');
        note.className = 'shortcut-unavailable';
        note.textContent = t('settings.shortcuts.unavailable');
        keys.prepend(note);
      }
      return [name, keys];
    }),
  );
}
async function showShortcuts() {
  if (!window.appShortcuts) return;
  try {
    shortcutStatus = await window.appShortcuts.status();
  } catch {
    return;
  }
  renderShortcuts();
}
async function applyGlobalShortcuts() {
  if (!window.appShortcuts) return;
  try {
    shortcutStatus = await window.appShortcuts.setEnabled(settings.globalShortcuts);
  } catch {
    return;
  }
  renderShortcuts();
}
window.appShortcuts?.onCommand((command) => {
  if (command === 'toggle') els.toggle.click();
  else if (command === 'captions' && !els.pip.hidden) els.pip.click();
});
if (window.appShortcuts && !settings.globalShortcuts) applyGlobalShortcuts();

async function openCaptionWindow() {
  // Electron exposes documentPictureInPicture but requestWindow fails there, so check it first.
  if (IN_DESKTOP_APP) {
    const win = window.open('', CAPTION_WINDOW_NAME, 'width=720,height=220');
    if (!win) throw new MessageError('error.windowBlocked');
    return { win, overlay: true };
  }
  return { win: await window.documentPictureInPicture.requestWindow({ width: 640, height: 220 }), overlay: false };
}

els.pip.onclick = async () => {
  if (captionWindow) return captionWindow.close();
  let win, overlay;
  try {
    ({ win, overlay } = await openCaptionWindow());
  } catch (err) {
    return toast(t('toast.captionWindowFailed', { message: errorText(err) }), 6000, 'critical');
  }
  captionWindow = win;
  const css = win.document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('styles.css', location.href).href;
  win.document.head.append(css);
  win.document.title = t('caption.title');
  win.document.body.className = overlay ? 'pip overlay' : 'pip';
  // The layout that makes the zone fill the window is set inline, so it holds even if the
  // stylesheet in the new window is slow to load or an older cached copy.
  win.document.body.style.cssText = overlay
    ? 'margin:0;display:block;height:100vh;background:transparent;overflow:hidden'
    : 'margin:0;display:block;height:100vh;background:var(--bgColor-default, Canvas)';
  els.now.style.cssText = 'display:flex;width:100%;height:100vh;min-height:0;max-height:none;border-top:0';
  applyFontSize();
  applyCaptionOptions();
  const home = document.createComment('caption zone');
  els.now.before(home);
  win.document.body.append(els.now);
  let closeBtn = null;
  if (overlay) {
    // The overlay has no title bar, so it needs its own way to close.
    closeBtn = win.document.createElement('button');
    closeBtn.className = 'overlay-close icon-btn';
    closeBtn.title = t('caption.close');
    closeBtn.setAttribute('aria-label', closeBtn.title);
    closeBtn.append(octicon('x', win.document));
    closeBtn.onclick = () => win.close();
    win.document.body.append(closeBtn);
  }
  els.pip.setAttribute('aria-pressed', 'true');
  win.addEventListener(
    'pagehide',
    () => {
      closeBtn?.remove();
      els.now.style.cssText = '';
      home.replaceWith(els.now); // back to its place under the transcript
      captionWindow = null;
      els.pip.setAttribute('aria-pressed', 'false');
    },
    { once: true },
  );
};

// ---------- download ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

els.export.onclick = () => {
  if (isEmpty(current) && !(DEBUG && lastTrace)) return toast(t('toast.nothingToSave'));
  flushSaves(); // so the title and recording lengths are up to date
  const sess = current;
  const rows = sess.recordings.map((rec, i) => {
    const row = document.createElement('div');
    row.className = 'rec';
    const info = document.createElement('span');
    const length = run?.recording === rec ? t('export.recordingNow') : formatElapsed(rec.durationMs);
    info.textContent = t('export.recording', { n: i + 1, date: formatDateTime(rec.startedAt), length });
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    const label = document.createElement('span');
    label.textContent = t('export.save');
    save.append(octicon('download'), label);
    save.onclick = async () => {
      const chunks = await store.getAudioChunks(sess.id, rec.id).catch(() => []);
      if (!chunks.length) return toast(t('toast.recordingMissing'), 6000, 'critical');
      const ext = rec.mime.includes('mp4') ? 'm4a' : 'webm';
      download(new Blob(chunks, { type: rec.mime }), `${safeFileName(sess.title)}-${i + 1}.${ext}`);
    };
    row.append(info, save);
    return row;
  });
  if (rows.length) {
    const heading = document.createElement('h3');
    heading.textContent = t('export.recordings');
    rows.unshift(heading);
  }
  if (DEBUG && lastTrace) rows.push(traceDownloadButton(lastTrace, download));
  els.recordings.replaceChildren(...rows);
  els.exportDialog.showModal();
};

els.exportTranscript.onclick = () => {
  if (!current.segments.length) return toast(t('toast.noTranscript'));
  const { text, ext, mime } = buildTranscript(serialize(current), {
    format: els.exportFormat.value,
    content: els.exportContent.value,
    langLabel,
    summary: current.summary,
    labels: {
      ...Object.fromEntries(
        ['title', 'date', 'languages', 'duration', 'time', 'source', 'translation', 'separator', 'transcript'].map(
          (k) => [k, t(`file.${k}`)],
        ),
      ),
      ...Object.fromEntries(
        ['overview', 'keyPoints', 'decisions', 'actionItems', 'owner', 'due'].map((k) => [k, t(`summary.${k}`)]),
      ),
      summary: t('summary.title'),
      summaryTruncated: t('summary.truncated'),
    },
  });
  download(new Blob([text], { type: `${mime};charset=utf-8` }), `${safeFileName(current.title)}.${ext}`);
};

// ---------- summary ----------
// One summary request at a time. The panel is hidden while capturing, so it never moves the
// caption zone; whether it is expanded is remembered for the user, not per session.
let summarizing = null; // { session } while a request is in flight
let summaryOpen = true;
try {
  summaryOpen = localStorage.getItem('rt-summary-open') !== 'false';
} catch {
  /* private mode */
}
const hasFinished = (sess) => sess.segments.some((seg) => seg.src);
const isStale = (sess) => sess.segments.length > (sess.summary?.segmentCount ?? 0);
// The summary is written in the display language; the model is told its English name.
const uiLanguageName = () => LANGS.find((l) => l.display === getLocale())?.name ?? 'English';
const langName = (code) => LANGS.find((l) => l.code === code)?.name;

function renderSummary() {
  const sess = current;
  if (!sess) return;
  const sum = sess.summary && typeof sess.summary === 'object' ? sess.summary : null;
  const busy = summarizing?.session === sess;
  els.summary.hidden = !!run || !hasFinished(sess);
  els.summarize.setAttribute('aria-busy', String(busy));
  els.summarize.setAttribute('aria-disabled', String(!!summarizing));
  els.summarizeLabel.textContent = t(sum ? 'summary.update' : 'summary.summarize');
  els.summaryStatus.textContent = busy ? t('summary.working') : '';
  els.summaryMeta.textContent = busy
    ? ''
    : sum
      ? t('summary.generated', { date: formatDateTime(sum.generatedAt) })
      : t('summary.none');
  els.summaryToggle.hidden = !sum;
  els.summaryToggle.setAttribute('aria-expanded', String(summaryOpen));
  els.summaryStale.hidden = !sum || !isStale(sess);
  els.summaryBody.hidden = !sum || !summaryOpen;
  els.summaryTruncated.hidden = !sum?.truncated;
  els.summaryContent.replaceChildren(...(sum ? summaryNodes(sum) : []));
}

function summaryNodes(sum) {
  const section = (key, ...content) => {
    const box = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = t(key);
    box.append(heading, ...content);
    return box;
  };
  const list = (items, fill) => {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      fill(li, item);
      ul.append(li);
    }
    return ul;
  };
  const nodes = [];
  if (sum.overview) {
    const p = document.createElement('p');
    p.textContent = sum.overview;
    nodes.push(section('summary.overview', p));
  }
  for (const key of ['keyPoints', 'decisions']) {
    if (sum[key]?.length)
      nodes.push(
        section(
          `summary.${key}`,
          list(sum[key], (li, text) => {
            li.textContent = text;
          }),
        ),
      );
  }
  if (sum.actionItems?.length) {
    const items = list(sum.actionItems, (li, item) => {
      li.textContent = item.task;
      const details = [
        item.owner && `${t('summary.owner')}: ${item.owner}`,
        item.due && `${t('summary.due')}: ${item.due}`,
      ].filter(Boolean);
      if (!details.length) return;
      const detail = document.createElement('span');
      detail.className = 'summary-detail';
      detail.textContent = details.join(' ・ ');
      li.append(detail);
    });
    nodes.push(section('summary.actionItems', items));
  }
  return nodes;
}

els.summaryToggle.onclick = () => {
  summaryOpen = !summaryOpen;
  try {
    localStorage.setItem('rt-summary-open', String(summaryOpen));
  } catch {
    /* private mode */
  }
  renderSummary();
};

els.summarize.onclick = async () => {
  const sess = current;
  if (run || summarizing || !hasFinished(sess)) return;
  if (!MOCK && !apiKey) {
    toast(t('toast.apiKeyFirst'), 6000, 'warning');
    return openSettings();
  }
  const segments = sess.segments.map(({ elapsed, src, tgt }) => ({ elapsed, src, tgt }));
  const model = MOCK ? 'demo' : settings.translateModel;
  const summarizer = MOCK ? new MockSummarizer() : new GeminiSummarizer({ apiKey, model });
  summarizing = { session: sess };
  renderSummary();
  try {
    const { summary, truncated } = await summarizer.summarize(segments, {
      language: uiLanguageName(),
      langA: langName(sess.langA),
      langB: langName(sess.langB),
    });
    sess.summary = { ...summary, truncated, generatedAt: Date.now(), model, segmentCount: segments.length };
    markDirty(sess);
  } catch (err) {
    // The previous summary, if any, stays as it was.
    if (err instanceof RateLimitError) toast(errorText(err), 10000, 'warning');
    else toast(t('toast.summaryFailed', { message: errorText(err) }), 10000, 'critical');
  } finally {
    summarizing = null;
    renderSummary();
  }
};

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
  r.tracker = createTracker(r);
  r.pacer = createInterimPacer(r);
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
    onState: (state) => run === r && setStatus(state),
    onError: (err) => {
      if (run === r) {
        toast(errorText(err), 10000, 'critical');
        stop();
      }
    },
  };
  if (MOCK) {
    r.translator = new MockTranslator();
    r.transcriber = new MockTranscriber(handlers);
  } else {
    r.translator = new GeminiTranslator({
      apiKey,
      model: settings.translateModel,
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
    r.autosave = setInterval(() => markDirty(sess), 5000); // keeps elapsed time and recording length current
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
  r.transcriber?.stop();
  reader.stop();
  r.tracker.flush(); // keep whatever was heard so far instead of dropping it
  if (live) {
    live.el.remove();
    live = null;
  }
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
function createTracker(r) {
  return new UtteranceTracker({
    commit(text, aboveLive) {
      if (aboveLive) {
        const seg = createSegment();
        if (live) live.el.before(seg.el);
        commit(r, seg, text);
        return seg;
      }
      if (!live) live = createSegment();
      return finalize(r, text);
    },
    setLive(text) {
      if (!text) {
        live?.el.remove();
        live = null;
        r.pacer.cancel();
        return;
      }
      if (!live) live = createSegment();
      setText(live, 'src', text);
      r.pacer.update(text);
    },
    correct: (seg, text) => commit(r, seg, text),
  });
}

// The sentence being spoken is translated as it grows; src/pacer.js decides when.
function createInterimPacer(r) {
  return createPacer({
    strategy: PACER,
    options: {
      enabled: () => settings.interimTranslate,
      interval: () => settings.interimInterval,
    },
    translate: (text, context) =>
      r.langs.length > 2 || intoSeveral(r, text)
        ? translateInterimLines(r, live, text, context)
        : r.translator.translate(text, { history: recentHistory(r), previous: context.previous?.() }),
    show: (out) => {
      clearTargets(live);
      setText(live, 'tgt', out, 'pending');
    },
    onRateLimit: () => toast(t('toast.rateLimited'), 6000, 'warning'),
  });
}

// With a third language, or two and a sentence in neither of them: the sentence in progress goes
// into the other languages, one request per line, but only when its writing system tells which
// language it is in (the model is not asked while the sentence is still growing).
// context: the pacer's; with a strategy that carries the shown translation, each line continues its own.
async function translateInterimLines(r, seg, text, context) {
  const source = sourceByScript(
    text,
    r.langs.map((l) => l.name),
  );
  if (!source) return;
  const targets = targetsFor(r, source);
  setTargets(seg, targets);
  const results = await Promise.allSettled(
    targets.map(async (code) => {
      const out = await r.translator.translate(text, {
        history: recentHistory(r, code),
        into: langName(code),
        previous: context.previous?.(code),
      });
      if (seg === live && out && seg.tgts.some((x) => x.lang === code)) {
        setLine(seg, code, out, 'pending');
        context.keep?.(code, out);
      }
    }),
  );
  const limited = results.find((x) => x.status === 'rejected' && x.reason instanceof RateLimitError);
  if (limited) throw limited.reason;
}
// The codes of the languages a sentence goes into: the selected ones other than the one it was
// spoken in (source: an English name or 'other'), in the order of the selects, narrowed by the
// setting for other languages.
const targetsFor = (r, source) =>
  targetLanguages(
    r.langs.map((l) => l.name),
    source,
    r.otherInto,
  ).map((name) => r.langs.find((l) => l.name === name).code);
// With two languages, a sentence whose writing system shows it is in neither goes into both, one
// tagged line each, unless the setting picks one of them. Everything else takes one request with
// the rules for two languages, which never asks the model which language it is.
const intoSeveral = (r, text) =>
  r.langs.length === 2 &&
  sourceByScript(
    text,
    r.langs.map((l) => l.name),
  ) === 'other' &&
  targetsFor(r, 'other').length > 1;
// Back to a single translation line (two languages, after lines for a sentence in neither).
function clearTargets(seg) {
  if (!seg.tgts) return;
  delete seg.tgts;
  delete seg.lang;
  seg.lines = null;
}

function finalize(r, text) {
  const seg = live;
  live = null;
  // With a strategy that carries the shown translation, the final one continues it.
  seg.previous = r.pacer.finish();
  commit(r, seg, text);
  return seg;
}

function commit(r, seg, text) {
  seg.el.classList.remove('live');
  seg.src = text;
  setText(seg, 'src', text);
  if (!r.session.segments.includes(seg)) r.session.segments.push(seg);
  markDirty(r.session);
  translateFinal(r, seg);
}

// lang: with a third language, the target whose own earlier translations are wanted.
function recentHistory(r, lang) {
  return r.session.segments
    .filter((x) => x.tgt)
    .slice(-HISTORY_LINES)
    .map(({ src, tgt, tgts }) => ({ src, tgt: (lang && tgts?.find((x) => x.lang === lang)?.text) || tgt }));
}

// What was shown while the sentence was spoken (previous(line), from the pacer), only for its
// first final translation: a corrected text is translated afresh.
function takePrevious(seg) {
  const previous = seg.previous;
  delete seg.previous;
  return previous;
}

async function translateFinal(r, seg) {
  if (r.langs.length > 2 || intoSeveral(r, seg.src)) return translateFinalLines(r, seg);
  const previous = takePrevious(seg)?.();
  const history = recentHistory(r);
  seg.rev = (seg.rev || 0) + 1; // a segment can be re-translated when its text is corrected
  const rev = seg.rev;
  clearTargets(seg);
  const shown = () => seg.rev === rev && seg.el.isConnected;
  // If a translation of the in-progress text is already on screen, swap it once when the final one
  // is complete rather than replacing it with a few words that grow again.
  const swapWhenDone = !!seg.tgtEl.textContent;
  for (let attempt = 0; ; attempt++) {
    try {
      let target = null;
      const out = await r.translator.translate(seg.src, {
        history,
        previous,
        onDelta: (partial) => {
          if (shown() && !swapWhenDone) setText(seg, 'tgt', partial);
        },
        onTarget: (language) => {
          target = language;
        },
      });
      if (seg.rev !== rev) return;
      seg.tgt = out;
      if (shown()) setText(seg, 'tgt', out);
      markDirty(r.session);
      if (!seg.spoken) seg.spoken = readTranslation(r, out, target);
      return;
    } catch (err) {
      if (err instanceof RateLimitError && attempt < 3) {
        await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
        continue;
      }
      if (shown()) setText(seg, 'tgt', errorText(err), 'error');
      return;
    }
  }
}

// With a third language: which language the sentence is in comes from its writing system, or else
// from the model; then it is translated into each of the others at once, each into its own line.
// With two languages this is only reached for a sentence the writing system shows is in neither.
async function translateFinalLines(r, seg) {
  const previous = takePrevious(seg);
  seg.rev = (seg.rev || 0) + 1;
  const rev = seg.rev;
  const names = r.langs.map((l) => l.name);
  const source = sourceByScript(seg.src, names) ?? (await r.translator.identify(seg.src, names).catch(() => 'other'));
  if (seg.rev !== rev) return;
  seg.lang = r.langs.find((l) => l.name === source)?.code ?? 'other';
  tagSource(seg);
  const targets = targetsFor(r, source);
  // Lines already showing a translation of the text in progress are swapped once, when complete.
  const kept = !setTargets(seg, targets);
  const swap = new Set(kept ? targets.filter((code) => seg.lines.get(code)?.lastChild.textContent) : []);
  await Promise.all(targets.map((code) => translateLine(r, seg, rev, code, swap.has(code), previous?.(code))));
}

async function translateLine(r, seg, rev, code, swapWhenDone, previous) {
  const history = recentHistory(r, code);
  const shown = () => seg.rev === rev && seg.el.isConnected;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await r.translator.translate(seg.src, {
        history,
        into: langName(code),
        previous,
        onDelta: (partial) => {
          if (shown() && !swapWhenDone) setLine(seg, code, partial);
        },
      });
      if (seg.rev !== rev) return;
      seg.tgts.find((x) => x.lang === code).text = out;
      seg.tgt = seg.tgts
        .map((x) => x.text)
        .filter(Boolean)
        .join('\n');
      if (shown()) setLine(seg, code, out);
      markDirty(r.session);
      // Each line is in a known language, so the one(s) chosen for reading aloud are read.
      seg.spokenLines ??= new Set();
      if (r.langs.length === 2 && !seg.spokenLines.has(code) && readTranslation(r, out, langName(code)))
        seg.spokenLines.add(code);
      return;
    } catch (err) {
      if (err instanceof RateLimitError && attempt < 3) {
        await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
        continue;
      }
      if (shown()) setLine(seg, code, errorText(err), 'error');
      return;
    }
  }
}

// Reads a finished translation aloud when it is in a language the user chose. Its language comes
// from its writing system, else from what the translator was told to translate into; when neither
// settles it, it is not read. Returns whether it was read.
function readTranslation(r, text, target) {
  if (run !== r || settings.readAloud === 'off' || !reader.available) return false;
  const [a, b] = r.langs;
  if (!scriptsDiffer(a.name, b.name)) return false;
  const name = languageByScript(text, a.name, b.name) ?? target;
  const lang = r.langs.find((l) => l.name === name);
  const wanted = { A: [settings.langA], B: [settings.langB], both: [settings.langA, settings.langB] };
  if (!lang || !wanted[settings.readAloud]?.includes(lang.code)) return false;
  reader.speak(text, lang.code);
  return true;
}

// ---------- startup ----------
setStatus('idle');
els.toggle.textContent = t('toggle.start');
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
showSession(sessions.find((x) => x.id === lastId) ?? blankSession());
if (MOCK) toast(t('toast.demo'), 4000);
