import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFlow } from '../../../../src/translation/flow.js';
import { RateLimitError } from '../../../../src/translation/translator.js';
import { LANGS } from '../../../../src/ui/langs.js';
import { MessageError } from '../../../../src/ui/message-error.js';
import { sameTargets } from '../../../../src/ui/transcript-view.js';

const lang = (code) => LANGS.find((l) => l.code === code);
const JA = lang('ja-JP');
const EN = lang('en-US');
const KO = lang('ko-KR');

// The page as the flow sees it: what each segment shows, kept in plain objects. Like the real view,
// lines stay on the page after clearTargets until a single translation replaces them (`shownLines`),
// and the single translation shown is then their text, language tags included.
function standInView() {
  // seg -> { src, text, cls, lines: Map(code -> { text, cls }) | null, shownLines, onPage }
  const page = new Map();
  const shown = (p) => (p.shownLines ? [...p.shownLines].map(([code, line]) => code + line.text).join('') : p.text);
  return {
    page,
    mount(seg) {
      page.set(seg, {
        src: seg.src,
        text: seg.tgt,
        cls: 'pending',
        lines: null,
        shownLines: null,
        onPage: true,
        live: true,
      });
      return seg;
    },
    unmount: (seg) => {
      page.get(seg).onPage = false;
    },
    placeBefore() {},
    markFinished: (seg) => {
      page.get(seg).live = false;
    },
    isMounted: (seg) => page.get(seg).onPage,
    shownTranslation: (seg, code) => (code === undefined ? shown(page.get(seg)) : page.get(seg).lines?.get(code)?.text),
    setText(seg, part, text, cls) {
      if (part === 'src') page.get(seg).src = text;
      else Object.assign(page.get(seg), { text, cls, shownLines: null });
    },
    setTargets(seg, codes) {
      if (page.get(seg).lines && sameTargets(seg.tgts, codes)) return false;
      seg.tgts = codes.map((code) => ({ lang: code, text: '' }));
      page.get(seg).lines = new Map();
      page.get(seg).shownLines = page.get(seg).lines;
      return true;
    },
    clearTargets(seg) {
      if (!seg.tgts) return;
      delete seg.tgts;
      delete seg.lang;
      page.get(seg).lines = null;
    },
    setLine(seg, code, text, cls) {
      page.get(seg).lines.set(code, { text, cls });
    },
    tagSource() {},
  };
}

// A translator whose answers the test gives: each request waits until answered or failed.
function standInTranslator() {
  const requests = [];
  return {
    requests,
    translate(text, options) {
      return new Promise((resolve, reject) => requests.push({ text, options, resolve, reject }));
    },
    identify: async () => 'other',
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ langs = [JA, EN], readAloud = 'off', handover } = {}) {
  const view = standInView();
  const translator = standInTranslator();
  const spoken = [];
  const waits = [];
  const saved = [];
  const settings = { langA: langs[0].code, langB: langs[1].code, langC: langs[2]?.code ?? '', readAloud };
  let run = null;
  let ids = 0;
  const flow = createFlow({
    view,
    reader: { available: true, speak: (text, code) => spoken.push({ text, code }) },
    settings,
    getRun: () => run,
    selectedLangs: () => [settings.langA, settings.langB, settings.langC].filter(Boolean),
    markDirty: (sess) => saved.push(sess),
    errorText: (err) => `failed: ${err.key ?? err.message}`,
    onRateLimit: () => {},
    uid: () => `seg-${++ids}`,
    elapsedNow: () => 0,
    strategy: 'settle',
    now: () => 0,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  run = { session: { segments: [] }, langs, otherInto: 'all', translator };
  // What the pacer hands over when a sentence is finished.
  run.pacer = { update() {}, cancel() {}, finish: () => handover };
  run.tracker = flow.tracker(run);
  return { flow, run, view, translator, spoken, waits, saved, stop: () => (run = null) };
}

test('a finished sentence is translated and its translation is shown and saved', async () => {
  const { run, view, translator, saved } = setup();
  run.tracker.final('おはようございます、皆さん。');
  const [seg] = run.session.segments;
  assert.equal(seg.src, 'おはようございます、皆さん。');
  assert.equal(translator.requests.length, 1);
  translator.requests[0].resolve('Good morning, everyone.');
  await settle();
  assert.equal(seg.tgt, 'Good morning, everyone.');
  assert.equal(view.page.get(seg).text, 'Good morning, everyone.');
  assert.ok(saved.includes(run.session));
});

test('a late answer for the text a sentence had before it was corrected is dropped', async () => {
  const { run, view, translator } = setup();
  run.tracker.interim('Good morning every');
  run.tracker.interim('今日の議題');
  const [seg] = run.session.segments;
  assert.equal(seg.src, 'Good morning every');
  run.tracker.final('Good morning everyone.');
  assert.equal(seg.src, 'Good morning everyone.');
  const [old, corrected] = translator.requests.filter((x) => x.text.startsWith('Good morning'));
  corrected.resolve('皆さん、おはようございます。');
  await settle();
  old.resolve('おはよう、みんな');
  await settle();
  assert.equal(seg.tgt, '皆さん、おはようございます。');
  assert.equal(view.page.get(seg).text, '皆さん、おはようございます。');
});

test('a request refused for the rate limit is tried again after 1.5, 3 and 6 seconds, then the error is shown', async () => {
  const { run, view, translator, waits } = setup();
  run.tracker.final('おはようございます、皆さん。');
  const [seg] = run.session.segments;
  for (let attempt = 0; attempt < 4; attempt++) {
    await settle();
    translator.requests[attempt].reject(new RateLimitError('error.rateLimited'));
  }
  await settle();
  assert.equal(translator.requests.length, 4);
  assert.deepEqual(waits, [1500, 3000, 6000]);
  assert.equal(view.page.get(seg).text, 'failed: error.rateLimited');
  assert.equal(view.page.get(seg).cls, 'error');
  assert.equal(seg.tgt, '');
});

const serverError = (status) => new MessageError('error.translate', { status, message: 'The model is overloaded.' });

for (const [name, failure] of [
  ['a server error (503)', () => serverError(503)],
  ['a network error', () => new TypeError('Failed to fetch')],
]) {
  test(`a request that fails with ${name} is tried again after 1.5, 3 and 6 seconds, then the error is shown`, async () => {
    const { run, view, translator, waits } = setup();
    run.tracker.final('おはようございます、皆さん。');
    const [seg] = run.session.segments;
    for (let attempt = 0; attempt < 4; attempt++) {
      await settle();
      translator.requests[attempt].reject(failure());
    }
    await settle();
    assert.equal(translator.requests.length, 4);
    assert.deepEqual(waits, [1500, 3000, 6000]);
    assert.equal(view.page.get(seg).cls, 'error');
    assert.equal(seg.tgt, '');
  });
}

test('a sentence whose first request fails with a server error is translated by the next one', async () => {
  const { run, view, translator, waits } = setup();
  run.tracker.final('おはようございます、皆さん。');
  const [seg] = run.session.segments;
  translator.requests[0].reject(serverError(500));
  await settle();
  translator.requests[1].resolve('Good morning, everyone.');
  await settle();
  assert.deepEqual(waits, [1500]);
  assert.equal(seg.tgt, 'Good morning, everyone.');
  assert.equal(view.page.get(seg).text, 'Good morning, everyone.');
  assert.notEqual(view.page.get(seg).cls, 'error');
});

test('a request that fails for a reason that will not pass is not tried again', async () => {
  for (const failure of [serverError(400), serverError(403), new Error('offline')]) {
    const { run, view, translator, waits } = setup();
    run.tracker.final('おはようございます、皆さん。');
    const [seg] = run.session.segments;
    translator.requests[0].reject(failure);
    await settle();
    assert.equal(translator.requests.length, 1, failure.message);
    assert.deepEqual(waits, []);
    assert.equal(view.page.get(seg).text, `failed: ${failure.key ?? failure.message}`);
    assert.equal(view.page.get(seg).cls, 'error');
  }
});

test('a request for a text corrected since is not tried again after a failure that would pass', async () => {
  for (const failure of [serverError(503), new RateLimitError('error.rateLimit')]) {
    const { run, translator, waits } = setup();
    run.tracker.interim('Good morning every');
    run.tracker.interim('今日の議題');
    run.tracker.final('Good morning everyone.');
    const [old, corrected] = translator.requests.filter((x) => x.text.startsWith('Good morning'));
    assert.equal(old.text, 'Good morning every');
    old.reject(failure);
    await settle();
    corrected.resolve('皆さん、おはようございます。');
    await settle();
    assert.deepEqual(waits, [], failure.message);
    assert.equal(translator.requests.filter((x) => x.text.startsWith('Good morning')).length, 2);
    assert.equal(run.session.segments[0].tgt, '皆さん、おはようございます。');
  }
});

test('with three languages a line whose request fails with a server error is tried again', async () => {
  const { run, view, translator, waits } = setup({ langs: [JA, EN, KO] });
  run.tracker.final('Good morning, everyone.');
  await settle();
  const [seg] = run.session.segments;
  translator.requests[1].reject(serverError(502));
  translator.requests[0].resolve('皆さん、おはようございます。');
  await settle();
  assert.deepEqual(waits, [1500]);
  assert.equal(translator.requests.length, 3);
  assert.equal(translator.requests[2].options.into, 'Korean');
  translator.requests[2].resolve('여러분, 안녕하세요.');
  await settle();
  assert.equal(view.page.get(seg).lines.get('ko-KR').text, '여러분, 안녕하세요.');
  assert.notEqual(view.page.get(seg).lines.get('ko-KR').cls, 'error');
});

test('a finished sentence keeps the translation shown when the pacer says it already covers it', async () => {
  const { run, view, translator } = setup({
    handover: { previous: () => 'Good morning, everyone.', settled: () => 'Good morning, everyone.' },
  });
  run.tracker.final('おはようございます、皆さん。');
  await settle();
  const [seg] = run.session.segments;
  assert.equal(translator.requests.length, 0);
  assert.equal(seg.tgt, 'Good morning, everyone.');
  assert.equal(view.page.get(seg).text, 'Good morning, everyone.');
});

test('a finished sentence gets its own request when the pacer has nothing settled', async () => {
  const { run, translator } = setup({ handover: { previous: () => 'Good morning', settled: () => null } });
  run.tracker.final('おはようございます、皆さん。');
  await settle();
  assert.equal(translator.requests.length, 1);
  assert.equal(translator.requests[0].options.previous, 'Good morning');
});

test('a finished translation is read aloud once, also when the sentence is corrected later', async () => {
  const { run, translator, spoken } = setup({ readAloud: 'B' });
  run.tracker.interim('おはようございます、皆さ');
  run.tracker.interim('Next topic');
  translator.requests[0].resolve('Good morning, everyone.');
  await settle();
  assert.deepEqual(spoken, [{ text: 'Good morning, everyone.', code: 'en-US' }]);
  run.tracker.final('おはようございます、皆さん。');
  translator.requests.at(-1).resolve('Good morning to you all.');
  await settle();
  assert.equal(run.session.segments[0].tgt, 'Good morning to you all.');
  assert.equal(spoken.length, 1);
});

test('nothing is read aloud once the run has stopped', async () => {
  const { run, translator, spoken, stop } = setup({ readAloud: 'B' });
  run.tracker.final('おはようございます、皆さん。');
  stop();
  translator.requests[0].resolve('Good morning, everyone.');
  await settle();
  assert.equal(run.session.segments[0].tgt, 'Good morning, everyone.');
  assert.deepEqual(spoken, []);
});

test('a final translation into one language streams in place of the lines shown for the sentence in progress', async () => {
  const { run, view, translator } = setup();
  // Speech in neither language: the in-progress translation showed one line per language.
  run.tracker.interim('안녕하세요 여러분');
  const [seg] = view.page.keys();
  view.setTargets(seg, ['ja-JP', 'en-US']);
  view.setLine(seg, 'ja-JP', '皆さん、こんにちは', 'pending');
  view.setLine(seg, 'en-US', 'Hello, everyone', 'pending');
  // The finished text is mostly English, so it takes one request into Japanese.
  run.tracker.final('안녕하세요, Zoom meeting.');
  await settle();
  assert.equal(translator.requests.length, 1);
  translator.requests[0].options.onDelta('Zoom 会議');
  assert.equal(view.page.get(seg).text, 'Zoom 会議');
  assert.equal(view.shownTranslation(seg), 'Zoom 会議');
  translator.requests[0].resolve('こんにちは、Zoom 会議。');
  await settle();
  assert.equal(seg.tgt, 'こんにちは、Zoom 会議。');
  assert.equal(view.shownTranslation(seg), 'こんにちは、Zoom 会議。');
});

test('with three languages a sentence gets one translation line per other language, in the order of the selects', async () => {
  const { run, view, translator } = setup({ langs: [JA, EN, KO] });
  run.tracker.final('Good morning, everyone.');
  await settle();
  const [seg] = run.session.segments;
  assert.equal(seg.lang, 'en-US');
  assert.deepEqual(
    translator.requests.map((x) => x.options.into),
    ['Japanese', 'Korean'],
  );
  translator.requests[1].resolve('여러분, 안녕하세요.');
  translator.requests[0].resolve('皆さん、おはようございます。');
  await settle();
  assert.deepEqual(seg.tgts, [
    { lang: 'ja-JP', text: '皆さん、おはようございます。' },
    { lang: 'ko-KR', text: '여러분, 안녕하세요.' },
  ]);
  assert.equal(seg.tgt, '皆さん、おはようございます。\n여러분, 안녕하세요.');
  assert.equal(view.page.get(seg).lines.get('ja-JP').text, '皆さん、おはようございます。');
  assert.equal(view.page.get(seg).lines.get('ko-KR').text, '여러분, 안녕하세요.');
});

test('with three languages a line read aloud is read once', async () => {
  const { run, translator, spoken } = setup({ langs: [JA, EN, KO], readAloud: 'C' });
  run.tracker.final('Good morning, everyone.');
  await settle();
  translator.requests[0].resolve('皆さん、おはようございます。');
  translator.requests[1].resolve('여러분, 안녕하세요.');
  await settle();
  assert.deepEqual(spoken, [{ text: '여러분, 안녕하세요.', code: 'ko-KR' }]);
});

test('when the run stops, the sentence in progress is taken off the page', () => {
  const { flow, run, view } = setup();
  run.tracker.interim('おはようございま');
  const [seg] = view.page.keys();
  assert.equal(view.page.get(seg).onPage, true);
  flow.dropLive();
  assert.equal(view.page.get(seg).onPage, false);
  assert.equal(run.session.segments.length, 0);
});

test('the pacer the flow builds runs on the clock and timers it is given', async () => {
  let time = 1_000_000;
  const timers = [];
  const translator = standInTranslator();
  const settings = { langA: 'ja-JP', langB: 'en-US', langC: '', readAloud: 'off' };
  Object.assign(settings, { interimTranslate: true, interimInterval: 1.5 });
  const flow = createFlow({
    view: standInView(),
    reader: { available: false },
    settings,
    getRun: () => run,
    selectedLangs: () => ['ja-JP', 'en-US'],
    markDirty: () => {},
    errorText: (err) => err.message,
    onRateLimit: () => {},
    uid: () => 'seg-1',
    elapsedNow: () => 0,
    strategy: 'interval',
    now: () => time,
    setTimer: (fn, ms) => timers.push({ fn, at: time + ms }),
    clearTimer: () => {},
  });
  const run = { session: { segments: [] }, langs: [JA, EN], otherInto: 'all', translator };
  run.pacer = flow.pacer(run);
  run.tracker = flow.tracker(run);
  const fireNext = async () => {
    const timer = timers.shift();
    time = timer.at;
    timer.fn();
    await settle();
  };
  run.tracker.interim('おはようございます');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(translator.requests.length, 0, 'nothing goes out on a real timer');
  assert.deepEqual(
    timers.map((x) => x.at),
    [1_000_000],
  );
  await fireNext();
  assert.equal(translator.requests.length, 1, 'the request goes out when the injected timer fires');
  translator.requests[0].resolve('Good morning');
  await settle();
  run.tracker.interim('おはようございます、皆さん');
  assert.deepEqual(
    timers.map((x) => x.at),
    [1_000_000 + 1500],
    'the next one waits the interval on the injected clock',
  );
  await fireNext();
  assert.equal(translator.requests.length, 2);
  assert.equal(translator.requests[1].text, 'おはようございます、皆さん');
});
