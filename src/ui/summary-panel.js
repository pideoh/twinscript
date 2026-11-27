// The summary panel, the Summary tab of the main area: the template, length and language selects,
// making a summary (streamed into the panel as it arrives), the history of a session's summaries,
// copy, download and delete. The rules about which summaries a session has and which one is shown are in
// src/session/summaries.js; the request is src/session/summarizer.js.
//
// One summary request at a time; it goes on if another session is opened, and its result goes to
// the session it was made for. A session without finished speech gets a line saying there is no
// transcript yet in place of the panel; while capturing, no summary is made. Every render of the
// panel redraws the speaker tools too (renderSpeakerTools).

import { MockSummarizer } from '../debug/mock.js';
import { formatDateTime, safeFileName } from '../session/exporter.js';
import { markdownToHtml } from '../session/markdown.js';
import {
  chosenLanguage,
  hasFinished,
  legacySummary,
  lengthOrStandard,
  summariesOf as listOf,
  shownSummary as pickShown,
  staleness,
  summaryLanguages,
  summaryLines,
} from '../session/summaries.js';
import { GeminiSummarizer } from '../session/summarizer.js';
import { DEFAULT_TEMPLATE, PRESETS, presetById } from '../session/summary-templates.js';
import { RateLimitError } from '../translation/translator.js';
import { addTokens, emptyUsage } from '../usage/usage.js';
import { LANGS, langName } from './langs.js';

// els: the page's elements; t: i18n; getLocale(): the display language; settings: the live
// settings object (summaryTemplate, summaryLength, summaryLanguage, translateModel);
// saveSettings(): stores them; store: the session store (putSummary, deleteSummary); toast(message, ms,
// variant); errorText(err): an error's message; download(blob, name): saves a file; uid(): a new
// id; templates: the template store (src/ui/template-editor.js); langLabel(code): a language's
// name; getCurrent(), getRun(): the session on screen and the run in progress (or null);
// getApiKey(): the API key now; openSettings(): opens the settings dialog; markDirty(sess): saves
// it soon; isDeleted(sess): the user deleted it (a summary that arrives after that is dropped
// quietly); recordUsage(sess, usage): counts what a request used; speakerName(sess, id): a
// speaker's name or ''; renderSpeakerTools(): redraws the speaker tools; mock: the demo mode.
export function createSummaryPanel({
  els,
  t,
  getLocale,
  settings,
  saveSettings,
  store,
  toast,
  errorText,
  download,
  uid,
  templates,
  langLabel,
  getCurrent,
  getRun,
  getApiKey,
  openSettings,
  markDirty,
  isDeleted,
  recordUsage,
  speakerName,
  renderSpeakerTools,
  mock = false,
}) {
  let summarizing = null; // { session, text } while a request is in flight; text: the answer so far
  const shownSummaryId = new WeakMap(); // session -> id of the summary on screen (default: the latest)
  const displayLangCode = () => LANGS.find((l) => l.display === getLocale())?.code;
  const offeredLangs = LANGS.map((l) => l.code);

  const templateById = (id) => templates.byId(id);
  const templateName = (tpl) => templates.name(tpl);

  // A summary made by an earlier version, shown as the session's oldest summary, in the display language.
  function toEntry(sum) {
    const labels = Object.fromEntries(
      ['overview', 'keyPoints', 'decisions', 'actionItems', 'owner', 'due'].map((k) => [k, t(`summary.${k}`)]),
    );
    return legacySummary(sum, { labels, templateName: templateName(presetById(DEFAULT_TEMPLATE)) });
  }
  // The session's summaries, oldest first.
  const summariesOf = (sess) => listOf(sess, toEntry);
  const shownSummary = (sess, list = summariesOf(sess)) => pickShown(list, shownSummaryId.get(sess));

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
      ...(templates.custom().length ? [group(t('summary.custom'), templates.custom())] : []),
    );
    if (!templateById(settings.summaryTemplate)) settings.summaryTemplate = DEFAULT_TEMPLATE;
    els.summaryTemplate.value = settings.summaryTemplate;
  }

  function fillSummaryLanguages(sess) {
    const codes = summaryLanguages(sess, displayLangCode(), offeredLangs);
    const key = `${getLocale()}|${codes.join()}`;
    if (els.summaryLanguage.dataset.key !== key) {
      els.summaryLanguage.replaceChildren(...codes.map((c) => new Option(langLabel(c), c)));
      els.summaryLanguage.dataset.key = key;
    }
    els.summaryLanguage.value = chosenLanguage(codes, settings.summaryLanguage, displayLangCode());
  }

  let shownMarkdown = null; // what #summaryContent was last rendered from
  function showMarkdown(markdown) {
    if (markdown === shownMarkdown) return;
    shownMarkdown = markdown;
    // Every piece of the text is escaped by markdown.js; only its own tags are produced.
    els.summaryContent.innerHTML = markdown ? markdownToHtml(markdown, { headingLevel: 3 }) : '';
  }

  function renderSummary() {
    const sess = getCurrent();
    if (!sess) return;
    const list = summariesOf(sess);
    const busy = summarizing?.session === sess;
    const shown = busy ? null : shownSummary(sess, list);
    els.summary.hidden = !hasFinished(sess);
    els.summaryEmpty.hidden = !els.summary.hidden;
    fillSummaryLanguages(sess);
    els.summarize.setAttribute('aria-busy', String(busy));
    els.summarize.setAttribute('aria-disabled', String(!!summarizing || !!getRun()));
    els.summaryStatus.textContent = busy ? t('summary.working') : '';
    els.summaryMeta.textContent = busy || list.length ? '' : t('summary.none');
    // Outdated: speech was added after the summary, or the speakers were labelled after it.
    const { stale, speakersOnly } = staleness(sess, shown);
    els.summaryStale.hidden = !stale;
    els.summaryStale.title = t(speakersOnly ? 'summary.staleSpeakersHelp' : 'summary.staleHelp');
    els.summaryBody.hidden = !busy && !shown;
    els.summaryHistoryBar.hidden = !shown;
    if (shown) {
      els.summaryHistory.replaceChildren(
        ...list
          .slice()
          .reverse()
          .map(
            (s) =>
              new Option(t('summary.entry', { date: formatDateTime(s.createdAt), template: s.templateName }), s.id),
          ),
      );
      els.summaryHistory.value = shown.id;
      els.summaryDetails.textContent = shown.legacy
        ? t('summary.legacy', { template: shown.templateName })
        : t('summary.details', {
            template: shown.templateName,
            length: t(`summary.length.${lengthOrStandard(shown.length)}`),
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
      if (summarizing?.session === getCurrent()) showMarkdown(summarizing.text);
    });
  }

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
  settings.summaryLength = lengthOrStandard(settings.summaryLength);
  els.summaryLength.value = settings.summaryLength;
  fillSummaryTemplates();

  els.summarize.onclick = async () => {
    const sess = getCurrent();
    if (getRun() || summarizing || !hasFinished(sess)) return;
    if (!mock && !getApiKey()) {
      toast(t('toast.apiKeyFirst'), 6000, 'warning');
      return openSettings();
    }
    const template = templateById(els.summaryTemplate.value) ?? presetById(DEFAULT_TEMPLATE);
    const length = lengthOrStandard(els.summaryLength.value);
    const language = els.summaryLanguage.value || displayLangCode() || 'en-US';
    const segments = summaryLines(sess.segments, (id) => speakerName(sess, id));
    const model = mock ? 'demo' : settings.translateModel;
    const onUsage = (usageMetadata, used) => recordUsage(sess, addTokens(emptyUsage(), 'summary', used, usageMetadata));
    const summarizer = mock
      ? new MockSummarizer({ model: settings.translateModel, onUsage })
      : new GeminiSummarizer({ apiKey: getApiKey(), model, onUsage });
    summarizing = { session: sess, text: '' };
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
      if (isDeleted(sess)) return;
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
      if (isDeleted(sess)) return;
      if (err instanceof RateLimitError) toast(errorText(err), 10000, 'warning');
      else toast(t('toast.summaryFailed', { message: errorText(err) }), 10000, 'critical');
    } finally {
      summarizing = null;
      renderSummary();
    }
  };

  els.summaryHistory.onchange = () => {
    shownSummaryId.set(getCurrent(), els.summaryHistory.value);
    renderSummary();
  };

  els.summaryCopy.onclick = async () => {
    const shown = shownSummary(getCurrent());
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.markdown);
      toast(t('summary.copied'));
    } catch (err) {
      toast(t('summary.copyFailed', { message: err?.message ?? String(err) }), 6000, 'critical');
    }
  };

  els.summaryDownload.onclick = () => {
    const current = getCurrent();
    const shown = shownSummary(current);
    if (!shown) return;
    download(
      new Blob([`${shown.markdown}\n`], { type: 'text/markdown;charset=utf-8' }),
      `${safeFileName(current.title)} - ${safeFileName(shown.templateName)}.md`,
    );
  };

  els.summaryDelete.onclick = () => {
    const sess = getCurrent();
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

  return { render: renderSummary, summariesOf, fillTemplates: fillSummaryTemplates };
}
