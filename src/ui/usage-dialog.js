// The usage dialog (what this session, each period and each saved session used, and what it is
// estimated to cost) and the price fields in the settings dialog. The amounts come from
// src/usage/usage-stats.js, the prices and the records from the usage log (src/usage/usage-log.js).

import { formatDateTime } from '../session/exporter.js';
import { formatUsd, PRICES } from '../usage/pricing.js';
import { notAPrice, pendingOverrides as overridesOf, priceModels, priceText } from '../usage/usage-log.js';
import { formatDuration, sessionRows, totalsRows, usageView } from '../usage/usage-stats.js';

// els: the page's elements; t, getLocale: i18n; settings: the live settings object; getCurrent,
// getSessions, getRun: the session on screen, the saved sessions, the run in progress (or null);
// usageLog: { currentPrices, readDailyTotals, accrueListening }; defaultTranslateModel: the translation
// model of an empty field; diarizeModel: the speaker-label model.
export function createUsageDialog({
  els,
  t,
  getLocale,
  settings,
  getCurrent,
  getSessions,
  getRun,
  usageLog,
  defaultTranslateModel,
  diarizeModel,
}) {
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
    const run = getRun();
    if (run) usageLog.accrueListening(run);
    const prices = usageLog.currentPrices();
    const unpriced = new Set();

    // This session: its three parts and their sum.
    const sess = getCurrent();
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
        usageRow(t('usage.questions'), tokens('question')),
        viewRow(t('usage.total'), view, true),
      );
    }

    // Totals per period, from the daily totals.
    els.usageTotals.replaceChildren(
      ...totalsRows(usageLog.readDailyTotals(), prices).map((r) => {
        for (const model of r.unpriced) unpriced.add(model);
        return viewRow(t(`usage.period.${r.period}`), r);
      }),
    );

    // Saved sessions, most recent first.
    const rows = sessionRows(getSessions(), prices);
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
  let priceDraft = {}; // { [model]: { [field]: text } } as typed, until the dialog closes
  let pricesReset = false; // Reset was pressed: overrides of models not shown are dropped too
  const shownModels = () => priceModels(els.translateModel.value.trim() || defaultTranslateModel, diarizeModel);
  function fillPriceDraft(prices) {
    priceDraft = {};
    for (const [model, fields] of shownModels()) {
      priceDraft[model] = Object.fromEntries(fields.map((field) => [field, priceText(prices, model, field)]));
    }
    renderPriceFields();
  }
  function openPriceFields() {
    pricesReset = false;
    fillPriceDraft(usageLog.currentPrices().models);
  }
  function renderPriceFields() {
    const prices = usageLog.currentPrices().models;
    els.priceFields.replaceChildren(
      ...shownModels().map(([model, fields], i) => {
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
    const shown = Object.fromEntries(shownModels().map(([model]) => [model, priceDraft[model] ?? {}]));
    return overridesOf(shown, settings.priceOverrides, pricesReset);
  }
  function checkPrices() {
    let invalid = false;
    for (const input of els.priceFields.querySelectorAll('input')) {
      const bad = notAPrice(input.value);
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
    const wanted = shownModels().map(([model]) => model);
    if (shown.join('\n') !== wanted.join('\n')) renderPriceFields();
  });

  return {
    render: renderUsage,
    // Re-renders the usage dialog when it is open (a new record, a change of display language).
    refresh() {
      if (els.usageDialog.open) renderUsage();
    },
    openPriceFields,
    renderPriceFields,
    pendingOverrides,
  };
}
