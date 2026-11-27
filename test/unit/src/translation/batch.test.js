import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateLines } from '../../../../src/translation/batch.js';
import { RateLimitError } from '../../../../src/translation/translator.js';
import { LANGS } from '../../../../src/ui/langs.js';
import { MessageError } from '../../../../src/ui/message-error.js';

const lang = (code) => LANGS.find((l) => l.code === code);
const JA = lang('ja-JP');
const EN = lang('en-US');
const KO = lang('ko-KR');
const FR = lang('fr-FR');

const lines = (...texts) => texts.map((src) => ({ src, tgt: '' }));

// A translator that answers "T(<into or ->):<text>" and keeps what it was asked. fail(text, attempt)
// may throw; identified: what identify answers.
function standIn({ fail = () => {}, identified = 'other', delay = 0 } = {}) {
  const asked = [];
  const askedLanguage = [];
  let inFlight = 0;
  const seen = { asked, askedLanguage, most: 0 };
  seen.translate = async (text, { history, into, signal }) => {
    const attempt = asked.filter((a) => a.text === text && a.into === into).length;
    asked.push({ text, history, into });
    inFlight++;
    seen.most = Math.max(seen.most, inFlight);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      signal?.throwIfAborted();
      fail(text, attempt, into);
      return `T(${into ?? '-'}):${text}`;
    } finally {
      inFlight--;
    }
  };
  seen.identify = async (text, names) => {
    askedLanguage.push({ text, names });
    return identified;
  };
  return seen;
}
const noWait = () => Promise.resolve();

test('lines are translated in order, each with the earlier translated lines as context', async () => {
  const translator = standIn();
  const list = lines('One.', 'Two.', 'Three.', 'Four.', 'Five.');
  const progress = [];
  const failures = await translateLines(list, {
    langs: [JA, EN],
    otherInto: 'all',
    translator,
    concurrency: 1,
    onProgress: (p) => progress.push(p.done),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(
    list.map((l) => l.tgt),
    ['T(-):One.', 'T(-):Two.', 'T(-):Three.', 'T(-):Four.', 'T(-):Five.'],
  );
  assert.deepEqual(translator.asked[0].history, []);
  assert.deepEqual(translator.asked[4].history, [
    { src: 'Two.', tgt: 'T(-):Two.' },
    { src: 'Three.', tgt: 'T(-):Three.' },
    { src: 'Four.', tgt: 'T(-):Four.' },
  ]);
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  assert.ok(!('lang' in list[0]) && !('tgts' in list[0]), 'two languages: one translation, no lines per target');
});

test('a few requests run at once, never more', async () => {
  const translator = standIn({ delay: 5 });
  const list = lines(...Array.from({ length: 10 }, (_, i) => `Line ${i}.`));
  await translateLines(list, { langs: [JA, EN], otherInto: 'all', translator, concurrency: 3 });
  assert.equal(translator.most, 3);
  assert.ok(list.every((l) => l.tgt.startsWith('T(-):')));
});

test('a refused or passing failure is tried again after 1.5, 3 and 6 seconds, as while listening', async () => {
  const waits = [];
  const translator = standIn({
    fail: (text, attempt) => {
      if (text === 'Busy.' && attempt < 2) throw new RateLimitError('error.rateLimit');
      if (text === 'Down.') throw new MessageError('error.translate', { status: 503, message: 'unavailable' });
    },
  });
  const list = lines('Busy.', 'Down.');
  const failures = await translateLines(list, {
    langs: [JA, EN],
    otherInto: 'all',
    translator,
    concurrency: 1,
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(list[0].tgt, 'T(-):Busy.');
  assert.deepEqual(waits, [1500, 3000, 1500, 3000, 6000]);
  assert.equal(translator.asked.filter((a) => a.text === 'Down.').length, 4, 'tried four times in all');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].index, 1);
  assert.equal(failures[0].lang, null);
  assert.equal(failures[0].error.params.status, 503);
  assert.equal(list[1].tgt, '');
});

test('a line whose translation fails keeps its error and the others are translated', async () => {
  const translator = standIn({
    fail: (text) => {
      if (text === 'Blocked.') throw new MessageError('error.noTranslation');
    },
  });
  const list = lines('Before.', 'Blocked.', 'After.');
  const failures = await translateLines(list, { langs: [JA, EN], otherInto: 'all', translator, wait: noWait });
  assert.deepEqual(
    failures.map((f) => [f.index, f.lang, f.error.key]),
    [[1, null, 'error.noTranslation']],
  );
  assert.equal(translator.asked.filter((a) => a.text === 'Blocked.').length, 1, 'not a failure that passes');
  assert.deepEqual(
    list.map((l) => l.tgt),
    ['T(-):Before.', '', 'T(-):After.'],
  );
});

test('cancelling stops the run: it rejects and no further line is asked for', async () => {
  const controller = new AbortController();
  const translator = standIn({
    fail: (text) => {
      if (text === 'Two.') controller.abort();
    },
  });
  const list = lines('One.', 'Two.', 'Three.', 'Four.');
  await assert.rejects(
    translateLines(list, {
      langs: [JA, EN],
      otherInto: 'all',
      translator,
      concurrency: 1,
      signal: controller.signal,
    }),
    (err) => err.name === 'AbortError',
  );
  assert.deepEqual(
    translator.asked.map((a) => a.text),
    ['One.', 'Two.'],
  );
});

test('with three languages a line goes into each other one, told by its writing system, with its own context', async () => {
  const translator = standIn();
  const list = lines('Shall we start with the budget?', '予算から始めましょうか。');
  await translateLines(list, { langs: [JA, EN, KO], otherInto: 'all', translator, concurrency: 1 });
  assert.equal(list[0].lang, 'en-US');
  assert.deepEqual(list[0].tgts, [
    { lang: 'ja-JP', text: 'T(Japanese):Shall we start with the budget?' },
    { lang: 'ko-KR', text: 'T(Korean):Shall we start with the budget?' },
  ]);
  assert.equal(list[0].tgt, 'T(Japanese):Shall we start with the budget?\nT(Korean):Shall we start with the budget?');
  assert.equal(list[1].lang, 'ja-JP');
  assert.deepEqual(
    list[1].tgts.map((x) => x.lang),
    ['en-US', 'ko-KR'],
  );
  const korean = translator.asked.find((a) => a.text === '予算から始めましょうか。' && a.into === 'Korean');
  assert.deepEqual(korean.history, [{ src: 'Shall we start with the budget?', tgt: list[0].tgts[1].text }]);
  assert.deepEqual(translator.askedLanguage, [], 'the writing system settled it');
});

test('the model is asked which language a line is in only when the writing system does not tell', async () => {
  const translator = standIn({ identified: 'French' });
  const list = lines('On commence par le budget ?');
  await translateLines(list, { langs: [EN, FR, JA], otherInto: 'all', translator });
  assert.equal(translator.askedLanguage.length, 1);
  assert.deepEqual(translator.askedLanguage[0].names, ['English', 'French', 'Japanese']);
  assert.equal(list[0].lang, 'fr-FR');
  assert.deepEqual(
    list[0].tgts.map((x) => x.lang),
    ['en-US', 'ja-JP'],
  );
});

test('with two languages a line in neither goes into both, one line each; a target that fails is said for that line', async () => {
  const translator = standIn({
    fail: (_, __, into) => {
      if (into === 'English') throw new MessageError('error.translate', { status: 400, message: 'bad' });
    },
  });
  const list = lines('안녕하세요 오늘 회의를 시작합니다');
  const failures = await translateLines(list, { langs: [JA, EN], otherInto: 'all', translator, wait: noWait });
  assert.equal(list[0].lang, 'other');
  assert.deepEqual(list[0].tgts, [
    { lang: 'ja-JP', text: 'T(Japanese):안녕하세요 오늘 회의를 시작합니다' },
    { lang: 'en-US', text: '' },
  ]);
  assert.equal(list[0].tgt, 'T(Japanese):안녕하세요 오늘 회의를 시작합니다');
  assert.deepEqual(
    failures.map((f) => [f.index, f.lang]),
    [[0, 'en-US']],
  );
});

test('nothing to translate resolves at once', async () => {
  assert.deepEqual(await translateLines([], { langs: [JA, EN], otherInto: 'all', translator: standIn() }), []);
});
