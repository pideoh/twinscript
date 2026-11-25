// The settings dialog, the display language and the controls of the header that are settings (the
// three language selects, the swap button and the audio source): each field's read and write, opening,
// and saving when the dialog closes. Also the API key while the page runs, and re-localizing the page
// when the display language changes. The rules (which choices are offered for the languages selected,
// what follows what, what a field falls back to) are in src/storage/settings.js and src/ui/langs.js.
//
// Made during the startup pass, before the other parts of the screen: it fills the selects and applies
// the display language and the text size as it is made. What it asks of other parts goes through the
// callbacks below, which reach them only when called.

import { addFileSourceOption } from '../debug/debug-tools.js';
import { canCaptureSystemAudio } from '../speech/audio.js';
import {
  canReadAloud,
  knownUiLang,
  normalizeSettings,
  otherIntoChoices,
  readAloudChoices,
  shownOtherInto,
  shownReadAloud,
  translateModelOr,
  usableSource,
} from '../storage/settings.js';
import { applyTranslations, availableLocales, getLocale, resolveLocale, setLocale } from './i18n.js';
import { followLangChange, followPlace, followThirdLangChange, LANGS, langLabel as labelIn } from './langs.js';

// els: the page's elements; t: i18n; settings: the app's settings, changed in place;
// saveSettings(): writes them; captionKey(name): the name of a caption-zone setting for the languages
// selected; reader: the ReadAloud of the page; apiKey, keyStorage: the key loaded at startup and where
// it is kept; saveApiKey(key): stores a new key, resolving to where it is kept; debug: ?debug=1;
// getRun(): the run in progress, or null.
// Callbacks: onFontSize(): the caption window takes the new text size; onLangsChanged(): after the
// selected languages changed and were saved; onRelocalize(): re-renders the rest of the screen in the
// new display language; trimCaptions(), applyCaptionOptions(), applyClickThrough(),
// showCaptionControls(): the caption zone and window; showShortcuts(), applyGlobalShortcuts(): the
// global shortcuts; closeTemplateEditor(), renderTemplateList(): the summary templates;
// openPriceFields(), pendingOverrides(): the price fields (the overrides, or null while one is not a
// price); checkForUpdates(): asks for a newer version if it is time, or hides the notice.
export function createSettingsDialog({
  els,
  t,
  settings,
  saveSettings,
  captionKey,
  reader,
  apiKey,
  keyStorage,
  saveApiKey,
  debug,
  getRun,
  onFontSize,
  onLangsChanged,
  onRelocalize,
  trimCaptions,
  applyCaptionOptions,
  applyClickThrough,
  showCaptionControls,
  showShortcuts,
  applyGlobalShortcuts,
  closeTemplateEditor,
  renderTemplateList,
  openPriceFields,
  pendingOverrides,
  checkForUpdates,
}) {
  let languageNames = null; // Intl.DisplayNames for the UI language
  let key = apiKey; // the key in use; a new one is stored when the dialog closes
  let storedIn = keyStorage; // where it is kept

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
  // Re-renders everything on screen that is not static markup: this part's own text first.
  function relocalize() {
    applyLocale();
    for (const sel of [els.langA, els.langB, els.langC])
      for (const o of sel.options) o.text = o.value ? langLabel(o.value) : t('header.langC.none');
    els.uiLang.options[0].text = t('settings.uiLang.auto');
    fillOtherInto();
    fillReadAloud();
    showTuning();
    showKeyStorage();
    onRelocalize();
  }
  applyLocale();
  els.uiLang.add(new Option(t('settings.uiLang.auto'), 'auto'));
  for (const l of availableLocales()) els.uiLang.add(new Option(l.name, l.id));
  settings.uiLang = knownUiLang(
    settings.uiLang,
    availableLocales().map((l) => l.id),
  );
  els.uiLang.onchange = () => {
    settings.uiLang = els.uiLang.value;
    saveSettings();
    relocalize();
  };
  window.addEventListener('languagechange', () => {
    if (settings.uiLang === 'auto') relocalize();
  });

  // ---------- languages and audio source (header) ----------
  for (const sel of [els.langA, els.langB]) {
    for (const l of LANGS) sel.add(new Option(langLabel(l.code), l.code));
  }
  els.langC.add(new Option(t('header.langC.none'), ''));
  for (const l of LANGS) els.langC.add(new Option(langLabel(l.code), l.code));
  els.langA.value = settings.langA;
  els.langB.value = settings.langB;
  normalizeSettings(settings); // a stored third language or choice for other languages that no longer fits
  els.langC.value = settings.langC;
  const systemAudio = canCaptureSystemAudio();
  if (!systemAudio) {
    for (const option of els.source.querySelectorAll('option:not([value=mic])')) option.remove();
  }
  if (debug) addFileSourceOption(els.source);
  settings.source = usableSource(settings.source, { systemAudio, debug });
  els.source.value = settings.source;
  applyFontSize();

  // The caption window has its own text size; the main window's applies to everything else.
  function applyFontSize() {
    document.documentElement.style.setProperty('--fs', `${settings.fontSize}px`);
    onFontSize();
  }
  const picked = () => ({ A: els.langA.value, B: els.langB.value, C: els.langC.value });
  const stored = () => ({ A: settings.langA, B: settings.langB, C: settings.langC });
  function showLangs({ A, B, C }) {
    els.langA.value = A;
    els.langB.value = B;
    els.langC.value = C;
  }
  function onLangChange(side) {
    showLangs(followLangChange(side, picked(), stored()));
    langsChanged();
  }
  function onThirdLangChange() {
    showLangs(followThirdLangChange(picked(), stored()));
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
    onLangsChanged();
  }
  els.langA.onchange = () => onLangChange('A');
  els.langB.onchange = () => onLangChange('B');
  els.langC.onchange = onThirdLangChange;
  els.swap.onclick = () => {
    [els.langA.value, els.langB.value] = [els.langB.value, els.langA.value];
    langsChanged();
  };
  els.source.onchange = () => {
    settings.source = els.source.value;
    saveSettings();
  };

  // ---------- the dialog ----------
  els.openSettings.onclick = openSettings;
  function openSettings() {
    els.apiKey.value = key;
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
    els.settingsRunning.hidden = !getRun();
    els.settings.showModal();
  }
  function showKeyStorage() {
    els.apiKeyStorage.textContent = t(`settings.apiKey.storage.${storedIn}`);
  }
  // All selected languages, or one of them. A choice not yet saved survives a change of display
  // language.
  function fillOtherInto() {
    const value = els.otherInto.value || settings.otherInto;
    const choices = otherIntoChoices(settings);
    els.otherInto.replaceChildren(
      ...choices.map(
        (c) =>
          new Option(
            c.value === 'all' ? t('settings.otherInto.all') : t('settings.otherInto.only', { lang: langLabel(c.lang) }),
            c.value,
          ),
      ),
    );
    els.otherInto.value = shownOtherInto(value, choices);
  }
  function fillReadAloud() {
    els.readAloudField.hidden = !reader.available;
    const label = (c) => {
      if (c.value === 'off') return t('settings.readAloud.off');
      if (c.value === 'both') return t('settings.readAloud.both');
      return t('settings.readAloud.into', { lang: langLabel(c.lang) });
    };
    els.readAloud.replaceChildren(...readAloudChoices(settings).map((c) => new Option(label(c), c.value)));
    els.readAloud.value = shownReadAloud(settings);
    const available = canReadAloud(settings);
    els.readAloud.disabled = !available;
    els.readAloudUnavailable.hidden = available;
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
    const typed = els.apiKey.value.trim();
    if (typed !== key) {
      key = typed;
      saveApiKey(typed).then((storage) => {
        storedIn = storage;
        showKeyStorage();
      });
    }
    settings.translateModel = translateModelOr(els.translateModel.value);
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

  // Shows the languages of a session that is opened: `a`, `b` and `c` ('' for none) become the
  // selected languages, and the selects show them. Not saved here.
  function selectLangs(a, b, c) {
    setLangs(a, b, c);
    showLangs({ A: settings.langA, B: settings.langB, C: settings.langC });
  }

  return { open: openSettings, apiKey: () => key, langLabel, applyFontSize, selectLangs };
}
