import { addFileSourceOption, FILE_TAIL_MS, pickAudioFile, traceDownloadButton } from './debug/debug-tools.js';
import { MockSummarizer, MockTranscriber, MockTranslator } from './debug/mock.js';
import { createTrace } from './debug/trace.js';
import { MODEL as DIARIZE_MODEL, GeminiDiarizer, labelSpeakers } from './session/diarizer.js';
import { buildTranscript, formatDateTime, formatElapsed, safeFileName } from './session/exporter.js';
import { markdownToHtml } from './session/markdown.js';
import { decodeRecording } from './session/speaker-audio.js';
import { assignSpeakers, recordingTimeline } from './session/speakers.js';
import { GeminiSummarizer, legacySummaryToMarkdown } from './session/summarizer.js';
import {
  DEFAULT_TEMPLATE,
  exportTemplates,
  LENGTHS,
  MAX_FILE_BYTES,
  MAX_TEMPLATES,
  mergeTemplates,
  PRESETS,
  parseTemplateFile,
  presetById,
  readStoredTemplates,
  storedTemplatesJson,
  validateTemplate,
} from './session/summary-templates.js';
import { AudioCapture, canCaptureSystemAudio, inMacDesktopApp } from './speech/audio.js';
import { canRecord, Recorder } from './speech/recorder.js';
import { UtteranceTracker } from './speech/segmenter.js';
import { GeminiLiveTranscriber } from './speech/transcriber.js';
import { applyReplacements, parseVocabulary } from './speech/vocabulary.js';
import { loadApiKey, saveApiKey } from './storage/secrets.js';
import { store } from './storage/store.js';
import { createPacer, DEFAULT_STRATEGY, strategyNamed } from './translation/pacer.js';
import { ReadAloud, readAloudLanguages } from './translation/read-aloud.js';
import {
  languageByScript,
  scriptsDiffer,
  sourceByScript,
  targetByScript,
  targetLanguages,
} from './translation/script-hint.js';
import { GeminiTranslator, RateLimitError } from './translation/translator.js';
import { applyTranslations, availableLocales, getLocale, resolveLocale, setLocale, t } from './ui/i18n.js';
import { octicon } from './ui/icons.js';
import { MessageError } from './ui/message-error.js';
import {
  afterCheck,
  checkDue,
  dismissVersion,
  readUpdateState,
  UPDATE_KEY,
  versionToAnnounce,
} from './ui/update-check.js';
import { formatUsd, mergePrices, PRICES } from './usage/pricing.js';
import { addListening, addTokens, addUsage, emptyUsage } from './usage/usage.js';
import {
  addToDaily,
  DAILY_KEY,
  emptyDaily,
  formatDuration,
  LIVE_MODEL,
  overridesFromFields,
  readDaily,
  sessionRows,
  totalsRows,
  usageView,
} from './usage/usage-stats.js';

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
  // Translations into which language are read aloud: 'off', 'A', 'B', 'C' (three languages only) or
  // 'both' (two languages only). A choice that does not fit the languages selected reads nothing.
  readAloud: 'off',
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
  checkUpdates: true, // desktop app: ask GitHub once a day whether a newer version is out
  interimInterval: 1.5, // seconds between re-translations of the sentence being spoken
  summaryTemplate: DEFAULT_TEMPLATE, // the template, length and language last used for a summary
  summaryLength: 'standard',
  summaryLanguage: '', // a language code, or '' for the display language
  // Prices for cost estimates that differ from src/usage/pricing.js: { [model]: { input?, output?, ... } }.
  priceOverrides: {},
};
const HISTORY_LINES = 3;
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
  fillSummaryTemplates();
  renderTemplateList();
  renderSummary();
  renderSpeakers();
  renderShortcuts();
  showUpdateNotice();
  if (els.settings.open) renderPriceFields();
  if (els.usageDialog.open) renderUsage();
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
// language that is turned off becomes 'all' for other languages and 'off' for reading aloud.
function setLangs(a, b, c) {
  const was = { A: settings.langA, B: settings.langB, C: settings.langC };
  const now = { A: a, B: b, C: c };
  const follow = (side, sides) =>
    sides.includes(side) && was[side] ? (sides.find((s) => now[s] === was[side]) ?? side) : side;
  settings.otherInto = follow(settings.otherInto, ['A', 'B', 'C']);
  if (settings.otherInto === 'C' && !c) settings.otherInto = 'all';
  settings.readAloud = follow(settings.readAloud, ['A', 'B', 'C']);
  if (settings.readAloud === 'C' && !c) settings.readAloud = 'off';
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
let live = null; // segment currently being spoken
let toastTimer;
const dirty = new Set();
let saveTimer;

// randomUUID needs a secure context; the fallback takes 128 bits from the same CSPRNG.
const uid = () =>
  crypto.randomUUID?.() ??
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const isEmpty = (sess) => !(sess.segments?.length ?? sess.segmentCount) && !sess.recordings.length;
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
    usage: emptyUsage(), // what it used of the API (src/usage/usage.js); absent in sessions made before it was counted
    segments: [],
    summaries: [],
    recordings: [],
  };
}

const serialize = (sess) => ({
  ...sess,
  segments: sess.segments.map(({ id, at, elapsed, src, tgt, lang, tgts, speaker }) => ({
    id,
    at,
    elapsed,
    src,
    tgt,
    ...(lang && { lang }),
    ...(tgts && { tgts: tgts.map(({ lang, text }) => ({ lang, text })) }),
    ...(speaker && { speaker }),
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
    if (!sess.customTitle && sess.segments)
      sess.title = sess.segments[0]?.src.slice(0, 30) || formatDateTime(sess.createdAt);
    if (!sessions.includes(sess)) {
      sessions.unshift(sess);
      store.requestPersistence();
    }
    store.saveSession(sess).catch((err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'));
  }
  dirty.clear();
  renderSidebar();
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
  live = null;
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
  // Who said it, once the speakers are labelled; shown only in the transcript (not the caption zone).
  const speakerEl = document.createElement('button');
  speakerEl.type = 'button';
  speakerEl.className = 'speaker';
  speakerEl.onclick = () => openSpeakerEditor(seg);
  const srcEl = document.createElement('div');
  srcEl.className = 'src';
  srcEl.textContent = seg.src;
  const tgtEl = document.createElement('div');
  tgtEl.className = `tgt${isLive ? ' pending' : ''}`;
  el.append(timeEl, speakerEl, srcEl, tgtEl);
  els.empty.hidden = true;
  Object.assign(seg, { el, speakerEl, srcEl, tgtEl });
  showSpeaker(seg);
  if (seg.tgts) {
    showTargets(seg);
    for (const { lang, text } of seg.tgts) if (text) setLine(seg, lang, text);
  } else {
    tgtEl.textContent = seg.tgt;
    tgtEl.dataset.lang = seg.tgt ? singleTag(seg, seg.tgt) : '';
  }
  tagSource(seg); // also for a segment loaded from storage, which does not go through setText
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

// ---------- newer versions (desktop app) ----------
// The main process asks GitHub (app/updates.js); this page decides when (src/ui/update-check.js): at
// start and then at most once every 24 hours, only while the setting is on. The last answer is
// kept, so the notice comes back at the next start without a request until it is dismissed or
// the app is updated. Failures say nothing.
const UPDATE_LOOK_MS = 60 * 60 * 1000; // how often a long-running app looks whether a check is due
let updateState = readUpdateState(null);
let runningVersion = null;
let updateChecking = false;
els.updatesGroup.hidden = !window.appUpdates;

function saveUpdateState() {
  try {
    localStorage.setItem(UPDATE_KEY, JSON.stringify(updateState));
  } catch {
    /* private mode */
  }
}
function showUpdateNotice() {
  const version = window.appUpdates && settings.checkUpdates ? versionToAnnounce(updateState, runningVersion) : null;
  els.updateNotice.hidden = !version;
  if (version) {
    els.updateNotice.dataset.version = version;
    els.updateText.textContent = t('update.available', { version });
  }
}
async function checkForUpdates() {
  if (!window.appUpdates || !runningVersion || updateChecking) return showUpdateNotice();
  if (settings.checkUpdates && checkDue(updateState, Date.now())) {
    updateChecking = true;
    let result = null;
    try {
      result = await window.appUpdates.check();
    } catch (err) {
      console.warn('update check failed', err);
    }
    updateChecking = false;
    updateState = afterCheck(updateState, result, Date.now());
    saveUpdateState();
  }
  showUpdateNotice();
}
async function startUpdateChecks() {
  if (!window.appUpdates) return;
  try {
    updateState = readUpdateState(localStorage.getItem(UPDATE_KEY));
  } catch {
    /* private mode: start empty */
  }
  try {
    runningVersion = await window.appUpdates.version();
  } catch (err) {
    console.warn('running version unknown', err);
    return;
  }
  await checkForUpdates();
  setInterval(checkForUpdates, UPDATE_LOOK_MS);
}
els.updateOpen.onclick = () => {
  window.appUpdates?.openReleasePage(els.updateNotice.dataset.version).catch(() => {});
};
els.updateDismiss.onclick = () => {
  updateState = dismissVersion(updateState, els.updateNotice.dataset.version);
  saveUpdateState();
  showUpdateNotice();
};

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
  const latest = summariesOf(current).at(-1);
  const exported = serialize(current);
  // Names, not ids, go into the file; a session without labels has none.
  for (const seg of exported.segments) seg.speaker = speakerName(current, seg.speaker);
  const { text, ext, mime } = buildTranscript(exported, {
    format: els.exportFormat.value,
    content: els.exportContent.value,
    langLabel,
    // The latest summary; the panel downloads any other one on its own.
    summary: latest && { markdown: latest.markdown, title: latest.templateName, truncated: latest.truncated },
    labels: {
      ...Object.fromEntries(
        [
          'title',
          'date',
          'languages',
          'duration',
          'time',
          'speaker',
          'source',
          'translation',
          'separator',
          'transcript',
        ].map((k) => [k, t(`file.${k}`)]),
      ),
      summary: t('summary.title'),
      summaryTruncated: t('summary.truncated'),
    },
  });
  download(new Blob([text], { type: `${mime};charset=utf-8` }), `${safeFileName(current.title)}.${ext}`);
};

// ---------- summary ----------
// One summary request at a time; every summary made is kept with its session, newest last. The
// panel is hidden while capturing, so it never moves the caption zone; whether it is expanded is
// remembered for the user, not per session.
let summarizing = null; // { session, text } while a request is in flight; text: the answer so far
let summaryOpen = true;
try {
  summaryOpen = localStorage.getItem('rt-summary-open') !== 'false';
} catch {
  /* private mode */
}
const shownSummaryId = new WeakMap(); // session -> id of the summary on screen (default: the latest)
const hasFinished = (sess) => sess.segments.some((seg) => seg.src);
const langName = (code) => LANGS.find((l) => l.code === code)?.name;
const displayLangCode = () => LANGS.find((l) => l.display === getLocale())?.code;

// Custom templates are kept in localStorage under their own key, apart from the settings (which
// are rewritten on every change); at most MAX_TEMPLATES of at most ~8 KB each stay well inside
// the browser's quota for this origin.
const TEMPLATES_KEY = 'rt-summary-templates';
let customTemplates = [];
try {
  customTemplates = readStoredTemplates(localStorage.getItem(TEMPLATES_KEY));
} catch {
  /* private mode */
}
// Throws when the browser refuses to store them (quota, private mode).
function saveTemplates(list) {
  localStorage.setItem(TEMPLATES_KEY, storedTemplatesJson(list));
  customTemplates = list;
}
const templateById = (id) => presetById(id) ?? customTemplates.find((tpl) => tpl.id === id) ?? null;
const templateName = (tpl) => (tpl.preset ? t(tpl.nameKey) : tpl.name);
const templateDescription = (tpl) => (tpl.preset ? t(tpl.descriptionKey) : tpl.description);

// A summary made by an earlier version, shown as the session's oldest summary. It stays on disk
// as it was until it is deleted; its Markdown is made here, in the display language.
function legacySummary(sum) {
  const labels = Object.fromEntries(
    ['overview', 'keyPoints', 'decisions', 'actionItems', 'owner', 'due'].map((k) => [k, t(`summary.${k}`)]),
  );
  return {
    id: 'legacy',
    legacy: true,
    templateId: DEFAULT_TEMPLATE,
    templateName: templateName(presetById(DEFAULT_TEMPLATE)),
    length: 'standard',
    language: null,
    createdAt: sum.generatedAt ?? 0,
    markdown: legacySummaryToMarkdown(sum, labels),
    model: sum.model ?? '',
    truncated: !!sum.truncated,
    segmentCount: sum.segmentCount ?? 0,
  };
}
// The session's summaries, oldest first.
function summariesOf(sess) {
  const old = sess.summary && typeof sess.summary === 'object' ? [legacySummary(sess.summary)] : [];
  return [...old, ...(sess.summaries ?? [])];
}
const shownSummary = (sess, list = summariesOf(sess)) =>
  list.find((s) => s.id === shownSummaryId.get(sess)) ?? list.at(-1) ?? null;

// The template select: the presets, then the user's own.
function fillSummaryTemplates() {
  const group = (label, templates) => {
    const box = document.createElement('optgroup');
    box.label = label;
    for (const tpl of templates) box.append(new Option(templateName(tpl), tpl.id));
    return box;
  };
  els.summaryTemplate.replaceChildren(
    group(t('summary.presets'), PRESETS),
    ...(customTemplates.length ? [group(t('summary.custom'), customTemplates)] : []),
  );
  if (!templateById(settings.summaryTemplate)) settings.summaryTemplate = DEFAULT_TEMPLATE;
  els.summaryTemplate.value = settings.summaryTemplate;
}

// The languages a summary can be written in: the session's, then the display language.
function summaryLanguages(sess) {
  const codes = [sess.langA, sess.langB, sess.langC, displayLangCode()].filter((c) => LANGS.some((l) => l.code === c));
  return [...new Set(codes)];
}
function fillSummaryLanguages(sess) {
  const codes = summaryLanguages(sess);
  const key = `${getLocale()}|${codes.join()}`;
  if (els.summaryLanguage.dataset.key !== key) {
    els.summaryLanguage.replaceChildren(...codes.map((c) => new Option(langLabel(c), c)));
    els.summaryLanguage.dataset.key = key;
  }
  els.summaryLanguage.value = codes.includes(settings.summaryLanguage)
    ? settings.summaryLanguage
    : (displayLangCode() ?? codes[0]);
}

let shownMarkdown = null; // what #summaryContent was last rendered from
function showMarkdown(markdown) {
  if (markdown === shownMarkdown) return;
  shownMarkdown = markdown;
  // Every piece of the text is escaped by markdown.js; only its own tags are produced.
  els.summaryContent.innerHTML = markdown ? markdownToHtml(markdown, { headingLevel: 3 }) : '';
}

function renderSummary() {
  const sess = current;
  if (!sess) return;
  const list = summariesOf(sess);
  const busy = summarizing?.session === sess;
  const shown = busy ? null : shownSummary(sess, list);
  els.summary.hidden = !!run || !hasFinished(sess);
  fillSummaryLanguages(sess);
  els.summarize.setAttribute('aria-busy', String(busy));
  els.summarize.setAttribute('aria-disabled', String(!!summarizing));
  els.summaryStatus.textContent = busy ? t('summary.working') : '';
  els.summaryMeta.textContent = busy || list.length ? '' : t('summary.none');
  els.summaryToggle.hidden = !busy && !list.length;
  els.summaryToggle.setAttribute('aria-expanded', String(summaryOpen));
  // Outdated: speech was added after the summary, or the speakers were labelled after it.
  const relabeled = !!shown && hasLabels(sess) && sess.speakerLabels.madeAt > shown.createdAt;
  els.summaryStale.hidden = !shown || (sess.segments.length <= shown.segmentCount && !relabeled);
  els.summaryStale.title = t(
    relabeled && sess.segments.length <= (shown?.segmentCount ?? 0) ? 'summary.staleSpeakersHelp' : 'summary.staleHelp',
  );
  els.summaryBody.hidden = (!busy && !shown) || !summaryOpen;
  els.summaryHistoryBar.hidden = !shown;
  if (shown) {
    els.summaryHistory.replaceChildren(
      ...list
        .slice()
        .reverse()
        .map(
          (s) => new Option(t('summary.entry', { date: formatDateTime(s.createdAt), template: s.templateName }), s.id),
        ),
    );
    els.summaryHistory.value = shown.id;
    els.summaryDetails.textContent = shown.legacy
      ? t('summary.legacy', { template: shown.templateName })
      : t('summary.details', {
          template: shown.templateName,
          length: t(`summary.length.${LENGTHS.includes(shown.length) ? shown.length : 'standard'}`),
          language: langLabel(shown.language),
        });
  }
  els.summaryDetails.hidden = !shown;
  els.summaryTruncated.hidden = !shown?.truncated;
  showMarkdown(busy ? summarizing.text : (shown?.markdown ?? ''));
  renderSpeakerTools();
}

// While the answer streams in, the panel follows it at most once a frame.
let contentFrame = 0;
function renderStreamingSummary() {
  if (contentFrame) return;
  contentFrame = requestAnimationFrame(() => {
    contentFrame = 0;
    if (summarizing?.session === current) showMarkdown(summarizing.text);
  });
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
els.summaryTemplate.onchange = () => {
  settings.summaryTemplate = els.summaryTemplate.value;
  saveSettings();
};
els.summaryLength.onchange = () => {
  settings.summaryLength = els.summaryLength.value;
  saveSettings();
};
els.summaryLanguage.onchange = () => {
  settings.summaryLanguage = els.summaryLanguage.value;
  saveSettings();
};
if (!LENGTHS.includes(settings.summaryLength)) settings.summaryLength = 'standard';
els.summaryLength.value = settings.summaryLength;
fillSummaryTemplates();

els.summarize.onclick = async () => {
  const sess = current;
  if (run || summarizing || !hasFinished(sess)) return;
  if (!MOCK && !apiKey) {
    toast(t('toast.apiKeyFirst'), 6000, 'warning');
    return openSettings();
  }
  const template = templateById(els.summaryTemplate.value) ?? presetById(DEFAULT_TEMPLATE);
  const length = LENGTHS.includes(els.summaryLength.value) ? els.summaryLength.value : 'standard';
  const language = els.summaryLanguage.value || displayLangCode() || 'en-US';
  // With speaker labels each line carries its speaker's name.
  const segments = sess.segments.map(({ elapsed, src, tgt, speaker }) => ({
    elapsed,
    src,
    tgt,
    ...(speakerName(sess, speaker) && { speaker: speakerName(sess, speaker) }),
  }));
  const model = MOCK ? 'demo' : settings.translateModel;
  const onUsage = (usageMetadata, used) => recordUsage(sess, addTokens(emptyUsage(), 'summary', used, usageMetadata));
  const summarizer = MOCK
    ? new MockSummarizer({ model: settings.translateModel, onUsage })
    : new GeminiSummarizer({ apiKey, model, onUsage });
  summarizing = { session: sess, text: '' };
  summaryOpen = true; // the answer is shown as it arrives
  renderSummary();
  try {
    const { markdown, truncated } = await summarizer.summarize(segments, {
      template,
      length,
      language: langName(language) ?? 'English',
      langs: [sess.langA, sess.langB, sess.langC].map(langName).filter(Boolean),
      onDelta: (text) => {
        summarizing.text = text;
        renderStreamingSummary();
      },
    });
    const summary = {
      id: uid(),
      templateId: template.id,
      templateName: templateName(template), // as it was, even if the template is renamed later
      length,
      language,
      createdAt: Date.now(),
      markdown,
      model,
      truncated,
      segmentCount: segments.length,
    };
    sess.summaries = [...(sess.summaries ?? []), summary];
    shownSummaryId.set(sess, summary.id);
    markDirty(sess); // the session record comes first in the list and is surely on disk
    store
      .putSummary(sess.id, summary)
      .catch((err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'));
  } catch (err) {
    // The summaries made before stay as they were.
    if (err instanceof RateLimitError) toast(errorText(err), 10000, 'warning');
    else toast(t('toast.summaryFailed', { message: errorText(err) }), 10000, 'critical');
  } finally {
    summarizing = null;
    renderSummary();
  }
};

els.summaryHistory.onchange = () => {
  shownSummaryId.set(current, els.summaryHistory.value);
  renderSummary();
};

els.summaryCopy.onclick = async () => {
  const shown = shownSummary(current);
  if (!shown) return;
  try {
    await navigator.clipboard.writeText(shown.markdown);
    toast(t('summary.copied'));
  } catch (err) {
    toast(t('summary.copyFailed', { message: err?.message ?? String(err) }), 6000, 'critical');
  }
};

els.summaryDownload.onclick = () => {
  const shown = shownSummary(current);
  if (!shown) return;
  download(
    new Blob([`${shown.markdown}\n`], { type: 'text/markdown;charset=utf-8' }),
    `${safeFileName(current.title)} - ${safeFileName(shown.templateName)}.md`,
  );
};

els.summaryDelete.onclick = () => {
  const sess = current;
  const shown = shownSummary(sess);
  if (!shown) return;
  const date = formatDateTime(shown.createdAt);
  if (!confirm(t('summary.deleteConfirm', { template: shown.templateName, date }))) return;
  if (shown.legacy) {
    delete sess.summary; // the session record is rewritten without it
  } else {
    sess.summaries = sess.summaries.filter((s) => s !== shown);
    store
      .deleteSummary(sess.id, shown.id)
      .catch((err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'));
  }
  shownSummaryId.delete(sess);
  markDirty(sess);
  renderSummary();
  (els.summaryHistoryBar.hidden || els.summaryBody.hidden ? els.summarize : els.summaryHistory).focus();
};

// ---------- speaker labels ----------
// After a session, who spoke when is told from its recording by the transcription model (src/session/speakers.js,
// src/session/diarizer.js). The session keeps `speakerLabels` (its speakers, numbered by their first line, when
// they were labelled, and whether any part of the recording could not be matched with certainty) and each
// segment the id of its `speaker`. An empty name is the default one, "Speaker n" in the display language.
// Labelling again replaces all of it. One labelling at a time; it goes on if another session is opened.
const SPEAKERS_CONSENT_KEY = 'rt-speakers-consent';
const MAX_SPEAKER_NAME = 40;
let labeling = null; // { session, controller, text } while speakers are being labelled
let speakerEditing = null; // { session, seg } while the editor is open; seg null when opened from the bar

function hasLabels(sess) {
  return Array.isArray(sess?.speakerLabels?.speakers);
}
// The name shown for a speaker id of `sess`, or '' for none.
function speakerName(sess, id) {
  const list = hasLabels(sess) && id ? sess.speakerLabels.speakers : [];
  const i = list.findIndex((s) => s.id === id);
  return i === -1 ? '' : list[i].name || t('speakers.default', { n: i + 1 });
}
// A stopped session with speech and a recording can be labelled.
const canLabel = (sess) => !run && hasFinished(sess) && sess.recordings.some((rec) => rec.durationMs > 0);

// A line's speaker: its name, quiet, in a column of its own; an empty slot (an icon on hover) without one.
function showSpeaker(seg) {
  const button = seg.speakerEl;
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
  if (!current) return;
  els.log.classList.toggle('has-speakers', hasLabels(current));
  for (const seg of current.segments ?? []) showSpeaker(seg);
  renderSpeakerTools();
}
function renderSpeakerTools() {
  const sess = current;
  const busy = labeling?.session === sess;
  const ready = canLabel(sess);
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
  if (labeling.session === current) els.speakersStatus.textContent = text;
}

// Whether the user agreed that recordings are uploaded for this; asked once.
function speakersConsented() {
  try {
    if (localStorage.getItem(SPEAKERS_CONSENT_KEY) === '1') return true;
  } catch {
    /* private mode: ask every time */
  }
  if (!confirm(t('speakers.consent'))) return false;
  try {
    localStorage.setItem(SPEAKERS_CONSENT_KEY, '1');
  } catch {
    /* private mode */
  }
  return true;
}

els.labelSpeakers.onclick = async () => {
  const sess = current;
  if (labeling || !canLabel(sess)) return;
  if (!apiKey) {
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
      diarizer: new GeminiDiarizer({ apiKey }),
      signal: controller.signal,
      onProgress: ({ step, part, parts }) =>
        setLabelingText(t(step === 'upload' ? 'speakers.uploading' : 'speakers.analyzing', { part, parts })),
      onUsage: (usageMetadata, model) =>
        recordUsage(sess, addTokens(emptyUsage(), 'diarization', model, usageMetadata)),
      // How the parts were matched, to judge it on real meetings: numbers only, no speech.
      onPart: DEBUG ? (report) => console.log('[speakers]', JSON.stringify(report)) : undefined,
    });
    decoded.length = 0;
    // Speakers are numbered by their first line; one who got no line is not listed.
    const ids = assignSpeakers(sess.segments, result.words, timeline);
    const order = [...new Set(ids.filter(Boolean))];
    const renumber = new Map(order.map((id, i) => [id, `s${i + 1}`]));
    sess.segments.forEach((seg, i) => {
      if (ids[i]) seg.speaker = renumber.get(ids[i]);
      else delete seg.speaker;
    });
    sess.speakerLabels = {
      speakers: order.map((_, i) => ({ id: `s${i + 1}`, name: '' })),
      madeAt: Date.now(),
      uncertain: result.uncertain,
      model: DIARIZE_MODEL,
    };
    markDirty(sess);
    if (sess === current) renderSpeakers();
    toast(
      t(result.uncertain ? 'speakers.doneUncertain' : 'speakers.done', { count: order.length }),
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
  const sess = current;
  if (!hasLabels(sess) || labeling?.session === sess || run) return;
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
    if (speaker) speaker.name = input.value.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEAKER_NAME);
  }
  if (seg) {
    const id = els.speakerLineSelect.value;
    if (id) seg.speaker = id;
    else delete seg.speaker;
  }
  markDirty(sess);
  if (sess === current) renderSpeakers();
  els.speakerDialog.close();
};
els.speakerDialog.addEventListener('close', () => {
  speakerEditing = null;
});

// ---------- summary templates (settings dialog) ----------
let editingTemplate = null; // { id } of the template in the editor; id null for a new one

function showTemplateStatus(message, variant = 'info') {
  els.templateStatus.textContent = message;
  els.templateStatus.dataset.variant = variant;
  els.templateStatus.hidden = false;
}

function renderTemplateList() {
  const action = (icon, label, fn) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.title = label.short;
    button.setAttribute('aria-label', label.full);
    button.append(octicon(icon));
    button.onclick = fn;
    return button;
  };
  els.templateList.replaceChildren(
    ...[...PRESETS, ...customTemplates].map((tpl) => {
      const name = templateName(tpl);
      const row = document.createElement('li');
      row.className = 'template-row';
      const text = document.createElement('div');
      text.className = 'template-text';
      const title = document.createElement('span');
      title.className = 'template-name';
      title.textContent = name;
      text.append(title);
      if (tpl.preset) {
        const badge = document.createElement('span');
        badge.className = 'label';
        badge.textContent = t('templates.builtIn');
        text.append(' ', badge);
      }
      const description = templateDescription(tpl);
      if (description) {
        const line = document.createElement('span');
        line.className = 'template-description';
        line.textContent = description;
        text.append(line);
      }
      const acts = document.createElement('div');
      acts.className = 'template-acts';
      const label = (key, full) => ({ short: t(key), full: t(full, { name }) });
      acts.append(
        action('copy', label('templates.duplicate', 'templates.duplicateOf'), () => openTemplateEditor(tpl, true)),
      );
      if (!tpl.preset)
        acts.append(
          action('pencil', label('templates.edit', 'templates.editOf'), () => openTemplateEditor(tpl)),
          action('trash', label('templates.delete', 'templates.deleteOf'), () => deleteTemplate(tpl)),
        );
      row.append(text, acts);
      return row;
    }),
  );
  els.templateExport.disabled = !customTemplates.length;
  els.templateNew.disabled = customTemplates.length >= MAX_TEMPLATES;
}

// tpl: the template to edit, or to start from when `copy` (a duplicate); none for a new one.
function openTemplateEditor(tpl, copy = false) {
  editingTemplate = { id: tpl && !copy ? tpl.id : null };
  els.templateEditorTitle.textContent = t(editingTemplate.id ? 'templates.editTitle' : 'templates.newTitle');
  els.templateName.value = tpl
    ? (copy ? t('templates.copyName', { name: templateName(tpl) }) : tpl.name).slice(0, els.templateName.maxLength)
    : '';
  els.templateDescription.value = tpl ? templateDescription(tpl) : '';
  els.templatePrompt.value = tpl?.prompt ?? '';
  els.templateError.hidden = true;
  els.templateStatus.hidden = true;
  els.templateEditor.hidden = false;
  els.templateEditor.scrollIntoView({ block: 'nearest' });
  els.templateName.focus();
}
function closeTemplateEditor() {
  editingTemplate = null;
  els.templateEditor.hidden = true;
}
function templatesChanged() {
  fillSummaryTemplates();
  renderTemplateList();
}

els.templateNew.onclick = () => openTemplateEditor(null);
els.templateCancel.onclick = () => {
  closeTemplateEditor();
  els.templateNew.focus();
};
// Enter in a one-line field would submit the settings form and close the dialog.
for (const input of [els.templateName, els.templateDescription]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
}
els.templateSave.onclick = () => {
  const error = (message) => {
    els.templateError.textContent = message;
    els.templateError.hidden = false;
  };
  if (!els.templateName.value.trim()) return error(t('templates.nameRequired'));
  if (!els.templatePrompt.value.trim()) return error(t('templates.promptRequired'));
  let template;
  try {
    template = validateTemplate({
      id: editingTemplate?.id ?? uid(),
      name: els.templateName.value,
      description: els.templateDescription.value,
      prompt: els.templatePrompt.value,
    });
  } catch (err) {
    return error(errorText(err));
  }
  const list = customTemplates.some((tpl) => tpl.id === template.id)
    ? customTemplates.map((tpl) => (tpl.id === template.id ? template : tpl))
    : [...customTemplates, template];
  try {
    if (list.length > MAX_TEMPLATES) throw new MessageError('templates.error.tooMany', { max: MAX_TEMPLATES });
    saveTemplates(list);
  } catch (err) {
    return error(t('templates.saveFailed', { message: errorText(err) }));
  }
  closeTemplateEditor();
  templatesChanged();
  showTemplateStatus(t('templates.saved', { name: template.name }));
  els.templateNew.focus();
};

function deleteTemplate(tpl) {
  if (!confirm(t('templates.deleteConfirm', { name: tpl.name }))) return;
  try {
    saveTemplates(customTemplates.filter((x) => x.id !== tpl.id));
  } catch (err) {
    return showTemplateStatus(t('templates.saveFailed', { message: errorText(err) }), 'critical');
  }
  if (editingTemplate?.id === tpl.id) closeTemplateEditor();
  templatesChanged();
  showTemplateStatus(t('templates.deleted', { name: tpl.name }));
  els.templateNew.focus();
}

els.templateExport.onclick = () => {
  if (!customTemplates.length) return;
  download(
    new Blob([exportTemplates(customTemplates)], { type: 'application/json' }),
    'twinscript-summary-templates.json',
  );
};
els.templateImport.onclick = () => els.templateImportFile.click();
els.templateImportFile.onchange = async () => {
  const file = els.templateImportFile.files[0];
  els.templateImportFile.value = '';
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES)
      throw new MessageError('templates.error.tooLarge', { max: Math.round(MAX_FILE_BYTES / 1000) });
    const imported = parseTemplateFile(await file.text(), { newId: uid });
    const { templates, added, replaced } = mergeTemplates(customTemplates, imported);
    saveTemplates(templates);
    templatesChanged();
    showTemplateStatus(t('templates.imported', { added, replaced }));
  } catch (err) {
    showTemplateStatus(t('templates.importFailed', { message: errorText(err) }), 'critical');
  }
};

// ---------- usage and cost estimates ----------
// Each session keeps what it used in `usage` (src/usage/usage.js), saved with its metadata. The same usage
// is added to running totals per calendar day in localStorage (src/usage/usage-stats.js), which outlive the
// sessions. In the demo mode the made-up usage goes into its session only, which is marked `demo`;
// the daily totals, the only source of the totals shown, never see it. `usagePartial` marks a session
// from before usage was counted that was used again afterwards: only the later part is known.
function currentPrices() {
  try {
    return mergePrices(PRICES, settings.priceOverrides);
  } catch {
    return PRICES; // stored overrides that are not valid (edited by hand) are ignored
  }
}
function readDailyTotals() {
  try {
    return readDaily(localStorage.getItem(DAILY_KEY));
  } catch {
    return emptyDaily();
  }
}
function addToDailyTotals(usage) {
  try {
    // Read again each time: another window of the app may have added to them.
    const daily = readDailyTotals();
    if (!daily.readOnly) localStorage.setItem(DAILY_KEY, JSON.stringify(addToDaily(daily, usage)));
  } catch {
    /* private mode or full storage: the session keeps its own record */
  }
}
// Adds `usage`, what one request or a stretch of listening used, to `sess` and to the totals.
function recordUsage(sess, usage) {
  if (!sess.usage) {
    if (sess.activeMs > 0 || !isEmpty(sess)) sess.usagePartial = true;
    sess.usage = emptyUsage();
  }
  try {
    sess.usage = addUsage(sess.usage, usage);
  } catch {
    /* a record written by a newer version is left as it is */
  }
  if (MOCK) sess.demo = true;
  else addToDailyTotals(usage);
  markDirty(sess);
  if (els.usageDialog.open) renderUsage();
}
// Listening time counts while the recognizer is connected (state 'listening').
function accrueListening(r) {
  if (!r.listeningSince) return;
  const now = Date.now();
  recordUsage(r.session, addListening(emptyUsage(), LIVE_MODEL, now - r.listeningSince));
  r.listeningSince = now;
}

const formatCount = (n) => new Intl.NumberFormat(getLocale()).format(n);
const costText = (part) => (part.noPrice ? t('usage.noPrice') : formatUsd(part.usd));
function cell(text, { header = false, num = false, className = '' } = {}) {
  const el = document.createElement(header ? 'th' : 'td');
  if (header) el.scope = 'row';
  el.className = [num && 'num', className].filter(Boolean).join(' ');
  el.textContent = text;
  return el;
}
const row = (...cells) => {
  const tr = document.createElement('tr');
  tr.append(...cells);
  return tr;
};
// One row of the tables with the columns label, listening time, requests, tokens in and out, cost.
// Cells left null stay empty (listening time has no tokens; translation has no listening time).
function usageRow(label, { listeningMs = null, requests = null, input = null, output = null, cost }, total = false) {
  const text = (value, format) => (value === null ? '' : format(value));
  const tr = row(
    cell(label, { header: true }),
    cell(text(listeningMs, formatDuration), { num: true }),
    cell(text(requests, formatCount), { num: true }),
    cell(text(input, formatCount), { num: true }),
    cell(text(output, formatCount), { num: true }),
    cell(costText(cost), { num: true }),
  );
  if (total) tr.className = 'usage-total';
  return tr;
}
const viewRow = (label, view, total = false) =>
  usageRow(
    label,
    {
      listeningMs: view.listeningMs,
      requests: view.requests,
      input: view.inputTokens,
      output: view.outputTokens,
      cost: view.cost.total,
    },
    total,
  );
function sessionLabel(text) {
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = text;
  return label;
}

function renderUsage() {
  if (run) accrueListening(run);
  const prices = currentPrices();
  const unpriced = new Set();

  // This session: its three parts and their sum.
  const sess = current;
  const recorded = !!sess?.usage;
  const notes = [];
  if (!recorded) notes.push(t('usage.notRecordedSession'));
  if (sess?.usagePartial) notes.push(t('usage.partialSession'));
  if (sess?.demo) notes.push(t('usage.demoSession'));
  els.usageSessionNote.textContent = notes.join(' ');
  els.usageSessionNote.hidden = !notes.length;
  els.usageSessionWrap.hidden = !recorded;
  if (recorded) {
    const view = usageView(sess.usage, prices);
    for (const model of view.unpriced) unpriced.add(model);
    const tokens = (kind) => ({
      requests: view[kind].requests,
      input: view[kind].inputTokens,
      output: view[kind].outputTokens,
      cost: view.cost[kind],
    });
    els.usageSession.replaceChildren(
      usageRow(t('usage.listening'), { listeningMs: view.listeningMs, cost: view.cost.transcription }),
      usageRow(t('usage.translation'), tokens('translation')),
      usageRow(t('usage.summary'), tokens('summary')),
      usageRow(t('usage.speakers'), tokens('diarization')),
      viewRow(t('usage.total'), view, true),
    );
  }

  // Totals per period, from the daily totals.
  els.usageTotals.replaceChildren(
    ...totalsRows(readDailyTotals(), prices).map((r) => {
      for (const model of r.unpriced) unpriced.add(model);
      return viewRow(t(`usage.period.${r.period}`), r);
    }),
  );

  // Saved sessions, most recent first.
  const rows = sessionRows(sessions, prices);
  els.usageSessions.replaceChildren(
    ...rows.map((r) => {
      const title = cell(r.title || formatDateTime(r.createdAt), { header: true, className: 'usage-title' });
      if (r.demo) title.append(' ', sessionLabel(t('usage.demo')));
      if (r.partial) title.append(' ', sessionLabel(t('usage.partial')));
      if (!r.recorded) {
        const none = cell(t('usage.notRecorded'), { className: 'muted' });
        none.colSpan = 2;
        return row(cell(formatDateTime(r.createdAt)), title, none);
      }
      for (const model of r.view.unpriced) unpriced.add(model);
      return row(
        cell(formatDateTime(r.createdAt)),
        title,
        cell(formatDuration(r.view.listeningMs), { num: true }),
        cell(costText(r.view.cost.total), { num: true }),
      );
    }),
  );
  if (!rows.length) {
    const none = cell(t('usage.noSessions'), { className: 'muted' });
    none.colSpan = 4;
    els.usageSessions.append(row(none));
  }

  els.usageUnpriced.textContent = unpriced.size ? t('usage.unpriced', { models: [...unpriced].join(', ') }) : '';
  els.usageUnpriced.hidden = !unpriced.size;
  const [y, m, d] = PRICES.asOf.split('-').map(Number);
  const date = new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(new Date(y, m - 1, d));
  const custom = Object.keys(settings.priceOverrides ?? {}).length > 0;
  els.usageNote.textContent = [t('usage.note', { date }), custom ? t('usage.customPrices') : '']
    .filter(Boolean)
    .join(' ');
}

els.openUsage.onclick = () => {
  renderUsage();
  els.usageDialog.showModal();
};

// ---------- prices for estimates (settings dialog) ----------
// The models in use and the prices each is estimated with: listening time for the live model, tokens
// for the translation model (which also writes the summaries) and for the speaker-label model.
const PRICE_UNITS = { listening: ['inputPerMinute', 'outputPerMinute'], tokens: ['input', 'output'] };
let priceDraft = {}; // { [model]: { [field]: text } } as typed, until the dialog closes
let pricesReset = false; // Reset was pressed: overrides of models not shown are dropped too
function priceModels() {
  const translation = els.translateModel.value.trim() || DEFAULTS.translateModel;
  const models =
    translation === LIVE_MODEL
      ? [[LIVE_MODEL, [...PRICE_UNITS.listening, ...PRICE_UNITS.tokens]]]
      : [
          [LIVE_MODEL, PRICE_UNITS.listening],
          [translation, PRICE_UNITS.tokens],
        ];
  // The model that labels speakers, in tokens.
  if (!models.some(([model]) => model === DIARIZE_MODEL)) models.push([DIARIZE_MODEL, PRICE_UNITS.tokens]);
  return models;
}
const priceText = (prices, model, field) => (prices[model]?.[field] === undefined ? '' : String(prices[model][field]));
function fillPriceDraft(prices) {
  priceDraft = {};
  for (const [model, fields] of priceModels()) {
    priceDraft[model] = Object.fromEntries(fields.map((field) => [field, priceText(prices, model, field)]));
  }
  renderPriceFields();
}
function openPriceFields() {
  pricesReset = false;
  fillPriceDraft(currentPrices().models);
}
function renderPriceFields() {
  const prices = currentPrices().models;
  els.priceFields.replaceChildren(
    ...priceModels().map(([model, fields], i) => {
      priceDraft[model] ??= {};
      const group = document.createElement('div');
      group.className = 'price-model';
      group.setAttribute('role', 'group');
      const title = document.createElement('h3');
      title.className = 'price-model-title';
      title.id = `priceModel${i}`;
      title.textContent = model;
      group.setAttribute('aria-labelledby', title.id);
      group.append(title);
      if (!PRICES.models[model]) {
        const help = document.createElement('small');
        help.className = 'caption';
        help.textContent = t('prices.noPrice');
        group.append(help);
      }
      const grid = document.createElement('div');
      grid.className = 'price-grid';
      for (const field of fields) {
        const label = document.createElement('label');
        label.className = 'form-control';
        const name = document.createElement('span');
        name.className = 'form-label';
        name.textContent = t(`prices.field.${field}`);
        const input = document.createElement('input');
        input.className = 'text-input';
        input.type = 'text';
        input.inputMode = 'decimal';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.dataset.model = model;
        input.dataset.field = field;
        priceDraft[model][field] ??= priceText(prices, model, field);
        input.value = priceDraft[model][field];
        input.oninput = () => {
          priceDraft[model][field] = input.value;
          checkPrices();
        };
        label.append(name, input);
        grid.append(label);
      }
      group.append(grid);
      return group;
    }),
  );
  checkPrices();
}
// The overrides the fields describe, or null while any of them is not a price.
function pendingOverrides() {
  const shown = Object.fromEntries(priceModels().map(([model]) => [model, priceDraft[model] ?? {}]));
  const overrides = overridesFromFields(shown, PRICES);
  // Overrides of a model not shown now (an earlier translation model) are kept, unless reset.
  if (!pricesReset) {
    for (const [model, values] of Object.entries(settings.priceOverrides ?? {})) {
      if (!(model in shown)) overrides[model] = values;
    }
  }
  try {
    mergePrices(PRICES, overrides);
    return overrides;
  } catch {
    return null;
  }
}
function checkPrices() {
  let invalid = false;
  for (const input of els.priceFields.querySelectorAll('input')) {
    const text = input.value.trim();
    const bad = text !== '' && !(Number(text.replace(',', '.')) >= 0);
    if (bad) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'pricesError');
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
    invalid ||= bad;
  }
  invalid ||= !pendingOverrides();
  els.pricesError.textContent = invalid ? t('prices.invalid') : '';
  els.pricesError.hidden = !invalid;
}
els.pricesReset.onclick = () => {
  pricesReset = true;
  fillPriceDraft(PRICES.models);
};
// A different translation model has prices of its own. The fields are rebuilt only then: the change
// event also comes when the field merely loses focus, often to a price field that must stay in place.
els.translateModel.addEventListener('change', () => {
  const shown = [...els.priceFields.querySelectorAll('h3')].map((h) => h.textContent);
  const wanted = priceModels().map(([model]) => model);
  if (shown.join('\n') !== wanted.join('\n')) renderPriceFields();
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

// The sentence being spoken is translated as it grows; src/translation/pacer.js decides when.
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
      if (out) context.answer?.(code, out);
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
  // With a strategy that carries the shown translation, the final one continues it; with settle,
  // the pacer also tells whether what is shown already translates the finished text.
  seg.handover = r.pacer.finish(text);
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

// What the pacer handed over when the sentence was finished, only for its first final
// translation: a corrected text is translated afresh. { previous, settled, pending }: previous(line)
// is what was shown while the sentence was spoken; settled(line) (or the promise `pending` of it,
// null when that request fails) the answers of an in-progress request made from the same text as
// the finished one, which then are the final translation (settle strategy only).
function takeHandover(seg) {
  const handed = seg.handover;
  delete seg.handover;
  if (typeof handed === 'function') return { previous: handed };
  return handed ?? {};
}
// The answers of a same-text in-progress request: settled(line), the promise `pending` of it, or
// null when there is none (then nothing is awaited, so the final request goes out at once).
const settledAnswers = ({ settled, pending }) => settled ?? pending ?? null;

async function translateFinal(r, seg) {
  if (r.langs.length > 2 || intoSeveral(r, seg.src)) return translateFinalLines(r, seg);
  const handover = takeHandover(seg);
  const previous = handover.previous?.();
  const history = recentHistory(r);
  seg.rev = (seg.rev || 0) + 1; // a segment can be re-translated when its text is corrected
  const rev = seg.rev;
  clearTargets(seg);
  const shown = () => seg.rev === rev && seg.el.isConnected;
  // If a translation of the in-progress text is already on screen, swap it once when the final one
  // is complete rather than replacing it with a few words that grow again.
  const swapWhenDone = !!seg.tgtEl.textContent;
  // settle: an in-progress translation of the same text is the final one, without another request.
  let answers = settledAnswers(handover);
  if (answers instanceof Promise) answers = await answers;
  if (seg.rev !== rev) return;
  const settled = answers?.();
  if (settled) {
    const target = r.translator.langs ? targetByScript(seg.src, r.translator.langs) : null; // as onTarget would say
    return finishFinal(r, seg, settled, target);
  }
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
      return finishFinal(r, seg, out, target);
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
// The steps after a sentence's single final translation is in, whether it was requested or settled.
function finishFinal(r, seg, out, target) {
  seg.tgt = out;
  if (seg.el.isConnected) setText(seg, 'tgt', out);
  markDirty(r.session);
  if (!seg.spoken) seg.spoken = readTranslation(r, out, target);
}

async function translateFinalLines(r, seg) {
  const handover = takeHandover(seg);
  const { previous } = handover;
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
  // settle: only when every line has an in-progress translation of the same text.
  let answers = settledAnswers(handover);
  if (answers instanceof Promise) answers = await answers;
  if (seg.rev !== rev) return;
  if (answers && targets.every((code) => answers(code))) {
    for (const code of targets) finishLine(r, seg, code, answers(code));
    return;
  }
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
      return finishLine(r, seg, code, out);
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

// The steps after one line's final translation is in, whether it was requested or settled.
function finishLine(r, seg, code, out) {
  seg.tgts.find((x) => x.lang === code).text = out;
  seg.tgt = seg.tgts
    .map((x) => x.text)
    .filter(Boolean)
    .join('\n');
  if (seg.el.isConnected) setLine(seg, code, out);
  markDirty(r.session);
  // Each line is in a known language, so the one(s) chosen for reading aloud are read.
  seg.spokenLines ??= new Set();
  if (seg.spokenLines.has(code)) return;
  const read = r.langs.length === 2 ? readTranslation(r, out, langName(code)) : readLine(r, out, code);
  if (read) seg.spokenLines.add(code);
}

// With three languages: reads a finished translation line aloud when it is into the language
// chosen. A sentence in that language has no line into it, so it is not read. Returns whether it
// was read.
function readLine(r, text, code) {
  if (run !== r || !reader.available) return false;
  if (!readAloudLanguages(settings.readAloud, selectedLangs()).includes(code)) return false;
  reader.speak(text, code);
  return true;
}

// Reads a finished translation aloud when it is in a language the user chose. Its language comes
// from its writing system, else from what the translator was told to translate into; when neither
// settles it, it is not read. Returns whether it was read.
function readTranslation(r, text, target) {
  if (run !== r || r.langs.length !== 2 || settings.readAloud === 'off' || !reader.available) return false;
  const [a, b] = r.langs;
  if (!scriptsDiffer(a.name, b.name)) return false;
  const name = languageByScript(text, a.name, b.name) ?? target;
  const lang = r.langs.find((l) => l.name === name);
  if (!lang || !readAloudLanguages(settings.readAloud, selectedLangs()).includes(lang.code)) return false;
  reader.speak(text, lang.code);
  return true;
}

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
await showSession(sessions.find((x) => x.id === lastId) ?? blankSession());
if (MOCK) toast(t('toast.demo'), 4000);
startUpdateChecks(); // not awaited: the app does not wait for GitHub
