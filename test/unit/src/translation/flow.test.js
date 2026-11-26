import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFlow } from '../../../../src/translation/flow.js';
import { createOwnVoice } from '../../../../src/translation/own-voice.js';
import { ReadAloud } from '../../../../src/translation/read-aloud.js';
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

const BROWSER = { desktop: false, platform: 'other' };

function setup({
  langs = [JA, EN],
  readAloud = 'off',
  source = 'mic',
  platform = BROWSER,
  handover,
  ownVoice,
  reader,
  pacer,
} = {}) {
  const view = standInView();
  const translator = standInTranslator();
  const spoken = [];
  const waits = [];
  const saved = [];
  const settings = { langA: langs[0].code, langB: langs[1].code, langC: langs[2]?.code ?? '', readAloud, source };
  let run = null;
  let ids = 0;
  const flow = createFlow({
    view,
    reader: reader ?? { available: true, speak: (text, code) => spoken.push({ text, code }) },
    ownVoice,
    settings,
    getRun: () => run,
    selectedLangs: () => [settings.langA, settings.langB, settings.langC].filter(Boolean),
    platform,
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
  run.pacer = pacer ?? { update() {}, cancel() {}, finish: () => handover };
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

const WINDOWS_APP = { desktop: true, platform: 'windows' };

test('in the Windows desktop app nothing is read aloud while PC audio is captured', async () => {
  for (const source of ['system', 'both']) {
    const { run, translator, spoken } = setup({ readAloud: 'B', source, platform: WINDOWS_APP });
    run.tracker.final('おはようございます、皆さん。');
    translator.requests[0].resolve('Good morning, everyone.');
    await settle();
    assert.equal(run.session.segments[0].tgt, 'Good morning, everyone.', source);
    assert.deepEqual(spoken, [], source);
  }
  const three = setup({ langs: [JA, EN, KO], readAloud: 'C', source: 'system', platform: WINDOWS_APP });
  three.run.tracker.final('Good morning, everyone.');
  await settle();
  three.translator.requests[0].resolve('皆さん、おはようございます。');
  three.translator.requests[1].resolve('여러분, 안녕하세요.');
  await settle();
  assert.deepEqual(three.spoken, [], 'three languages');
});

test('in the Windows desktop app translations are read aloud with the microphone as the source', async () => {
  const { run, translator, spoken } = setup({ readAloud: 'B', source: 'mic', platform: WINDOWS_APP });
  run.tracker.final('おはようございます、皆さん。');
  translator.requests[0].resolve('Good morning, everyone.');
  await settle();
  assert.deepEqual(spoken, [{ text: 'Good morning, everyone.', code: 'en-US' }]);
});

test('in the macOS desktop app translations are read aloud while PC audio is captured', async () => {
  const { run, translator, spoken } = setup({
    readAloud: 'B',
    source: 'both',
    platform: { desktop: true, platform: 'mac' },
  });
  run.tracker.final('おはようございます、皆さん。');
  translator.requests[0].resolve('Good morning, everyone.');
  await settle();
  assert.deepEqual(spoken, [{ text: 'Good morning, everyone.', code: 'en-US' }]);
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
    platform: BROWSER,
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

test('a finished sentence whose translation came back empty says so on its line and is not asked again', async () => {
  const { run, view, translator, waits } = setup();
  run.tracker.final('おはようございます、皆さん。');
  const [seg] = run.session.segments;
  translator.requests[0].reject(new MessageError('error.noTranslation'));
  await settle();
  assert.equal(translator.requests.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(view.page.get(seg).text, 'failed: error.noTranslation');
  assert.equal(view.page.get(seg).cls, 'error');
  assert.equal(seg.tgt, '');
});

test('with three languages only the line whose translation came back empty says so', async () => {
  const { run, view, translator } = setup({ langs: [JA, EN, KO] });
  run.tracker.final('Good morning, everyone.');
  await settle();
  const [seg] = run.session.segments;
  translator.requests[0].resolve('皆さん、おはようございます。');
  translator.requests[1].reject(new MessageError('error.noTranslation'));
  await settle();
  assert.equal(translator.requests.length, 2);
  assert.deepEqual(view.page.get(seg).lines.get('ja-JP'), { text: '皆さん、おはようございます。', cls: undefined });
  assert.deepEqual(view.page.get(seg).lines.get('ko-KR'), { text: 'failed: error.noTranslation', cls: 'error' });
  assert.equal(seg.tgt, '皆さん、おはようございます。');
});

// The app's own voice: what the reader reads aloud is told to the own-voice module, as in app.js.
// The synthesizer starts each sentence at once and never finishes it, so it is still being read.
function ownVoiceSetup(options = {}) {
  let time = 0;
  const ownVoice = createOwnVoice({ now: () => time });
  const utterances = [];
  const synth = {
    getVoices: () => [],
    speak(u) {
      utterances.push(u);
      u.onstart?.();
    },
    cancel() {},
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const told = [];
  const reader = new ReadAloud({
    synth,
    Utterance,
    onStart: (text, lang) => {
      told.push(text);
      ownVoice.started(text, lang);
    },
    onEnd: (text) => ownVoice.ended(text),
  });
  const pacer = { updates: [], update: (text) => pacer.updates.push(text), cancel() {}, finish() {} };
  const s = setup({ readAloud: 'B', ownVoice, reader, pacer, ...options });
  return {
    ...s,
    pacer,
    told,
    utterances,
    at: (ms) => {
      time = ms;
    },
    // A Japanese sentence, translated into English (and read aloud when that is on).
    async readAloud(src, out) {
      s.run.tracker.final(src);
      s.translator.requests.at(-1).resolve(out);
      await settle();
    },
  };
}

const onPage = (view) => [...view.page.entries()].filter(([, p]) => p.onPage).map(([seg]) => seg);

test('a sentence the app has just read aloud, heard again, is not shown, translated, saved or read', async () => {
  const { run, view, translator, saved, utterances, readAloud, at } = ownVoiceSetup();
  await readAloud('おはようございます、皆さん。', 'Good morning, everyone.');
  assert.deepEqual(
    utterances.map((u) => u.text),
    ['Good morning, everyone.'],
  );
  const savedBefore = saved.length;
  at(1500);
  run.tracker.final('Good morning everyone.');
  await settle();
  assert.equal(run.session.segments.length, 1);
  assert.equal(onPage(view).length, 1);
  assert.equal(translator.requests.length, 1);
  assert.equal(saved.length, savedBefore);
  assert.equal(utterances.length, 1);
});

test('the sentence after one the app read aloud is shown and translated as usual', async () => {
  const { run, view, translator, readAloud, at } = ownVoiceSetup();
  await readAloud('おはようございます、皆さん。', 'Good morning, everyone.');
  at(1500);
  run.tracker.interim('Good morning');
  run.tracker.final('Good morning, everyone.');
  run.tracker.interim('では始めましょう');
  run.tracker.final('では始めましょう。');
  const [first, second] = run.session.segments;
  assert.equal(first.id, 'seg-1');
  assert.equal(second.id, 'seg-2', 'no id was taken by the dropped sentence');
  assert.equal(second.src, 'では始めましょう。');
  assert.deepEqual(onPage(view), [first, second]);
  assert.equal(translator.requests.at(-1).text, 'では始めましょう。');
  translator.requests.at(-1).resolve('Let us begin.');
  await settle();
  assert.equal(second.tgt, 'Let us begin.');
  assert.equal(view.page.get(second).text, 'Let us begin.');
});

test('the app’s own voice in progress is not shown and not translated', async () => {
  const { run, view, pacer, readAloud, at, flow } = ownVoiceSetup();
  await readAloud('おはようございます、皆さん。', 'Good morning, everyone. Today we review the budget.');
  at(1000);
  run.tracker.interim('Good morning');
  run.tracker.interim('Good morning, everyone. Today we');
  assert.equal(onPage(view).length, 1, 'only the first sentence is on the page');
  assert.deepEqual(pacer.updates, []);
  run.tracker.final('Good morning, everyone. Today we review the budget.');
  flow.dropLive();
  assert.equal(onPage(view).length, 1);
  assert.equal(run.session.segments.length, 1);
});

test('a sentence in progress that grows away from what is read aloud is shown from then on', async () => {
  const { run, view, pacer, readAloud, at } = ownVoiceSetup();
  await readAloud('おはようございます、皆さん。', 'Good morning, everyone.');
  at(1000);
  run.tracker.interim('Good morning');
  assert.equal(onPage(view).length, 1);
  run.tracker.interim('Good morning, I would like to add a topic about hiring');
  const live = onPage(view)[1];
  assert.equal(view.page.get(live).src, 'Good morning, I would like to add a topic about hiring');
  assert.deepEqual(pacer.updates, ['Good morning, I would like to add a topic about hiring']);
  run.tracker.final('Good morning, I would like to add a topic about hiring.');
  assert.equal(run.session.segments[1], live);
});

test('the app’s own voice cut off when the run stops leaves nothing behind', async () => {
  const { run, view, readAloud, at, flow } = ownVoiceSetup();
  await readAloud('おはようございます、皆さん。', 'Good morning, everyone. Today we review the budget.');
  at(1000);
  run.tracker.interim('Good morning, everyone. Today we review');
  run.tracker.flush();
  flow.dropLive();
  assert.equal(onPage(view).length, 1);
  assert.equal(run.session.segments.length, 1);
});

test('a late final result for the app’s own voice does not bring it back', async () => {
  const { run, view, translator, readAloud, at } = ownVoiceSetup();
  await readAloud('おはようございます、皆さん。', 'Good morning, everyone. Today we review the budget.');
  at(1000);
  run.tracker.interim('Good morning, everyone. Today we review the budget');
  run.tracker.interim('それでは'); // a new utterance before the own one was finished
  run.tracker.final('Good morning, everyone. Today we review the budget.');
  run.tracker.final('それでは始めます。');
  assert.deepEqual(
    run.session.segments.map((x) => x.src),
    ['おはようございます、皆さん。', 'それでは始めます。'],
  );
  assert.equal(onPage(view).length, 2);
  assert.ok(translator.requests.every((x) => !x.text.startsWith('Good morning')));
});

test('with reading aloud off nothing is told about the app’s voice and nothing is dropped', async () => {
  const { run, view, translator, told, readAloud, at } = ownVoiceSetup({ readAloud: 'off' });
  await readAloud('おはようございます、皆さん。', 'Good morning, everyone.');
  assert.deepEqual(told, []);
  at(1500);
  run.tracker.interim('Good morning');
  assert.equal(onPage(view).length, 2, 'the sentence in progress is shown');
  run.tracker.final('Good morning everyone.');
  assert.equal(run.session.segments.length, 2);
  assert.equal(translator.requests.at(-1).text, 'Good morning everyone.');
});
