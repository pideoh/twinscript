import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecordingView } from '../../../scripts/tuning/recording-view.mjs';

function setup() {
  let time = 1000;
  const recording = createRecordingView({ now: () => time });
  return { recording, view: recording.view, at: (t) => (time = t) };
}

test('a sentence in progress records when its words came and each change of its translation', () => {
  const { recording, view, at } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  assert.equal(view.isMounted(seg), true);
  at(1200);
  view.setText(seg, 'src', 'おはよう');
  at(1500);
  view.setText(seg, 'src', 'おはようございます');
  view.setText(seg, 'tgt', 'Good', 'pending');
  at(1600);
  view.setText(seg, 'tgt', 'Good', 'pending');
  view.setText(seg, 'tgt', 'Good morning', 'pending');
  assert.equal(view.shownTranslation(seg), 'Good morning');
  const s = recording.sentence(seg, 1000);
  assert.equal(s.firstInterimAt, 200, 'the first words, counted from the start');
  assert.deepEqual(s.displays, [
    { t: 500, text: 'Good' },
    { t: 600, text: 'Good morning' },
  ]);
  assert.equal(s.finishedAt, null);
  assert.equal(s.finalShownAt, null);
});

test('the final translation is the one shown that the flow saved, and it settled when none was asked for', () => {
  const { recording, view, at } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  view.setText(seg, 'src', 'おはようございます');
  view.setText(seg, 'tgt', 'Good morning', 'pending');
  at(2000);
  view.markFinished(seg);
  seg.src = 'おはようございます。';
  view.setText(seg, 'src', seg.src);
  seg.tgt = 'Good morning.';
  at(2100);
  view.setText(seg, 'tgt', seg.tgt);
  const s = recording.sentence(seg);
  assert.equal(s.finishedAt, 2000);
  assert.equal(s.finalShownAt, 2100);
  assert.equal(s.finalText, 'Good morning.');
  assert.equal(s.settled, true);
});

test('a final request makes the sentence not settled, and a streamed part is not the final translation', () => {
  const { recording, view, at } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  view.markFinished(seg);
  seg.src = 'Thanks.';
  view.setText(seg, 'src', seg.src);
  recording.finalRequested('Thanks.');
  at(1300);
  view.setText(seg, 'tgt', 'ありがとう');
  assert.equal(recording.sentence(seg).finalShownAt, null, 'a part of the answer');
  seg.tgt = 'ありがとうございます。';
  at(1400);
  view.setText(seg, 'tgt', seg.tgt);
  const s = recording.sentence(seg);
  assert.equal(s.finalShownAt, 1400);
  assert.equal(s.settled, false);
  assert.deepEqual(
    s.displays.map((d) => d.text),
    ['ありがとう', 'ありがとうございます。'],
  );
});

test('a corrected sentence counts the final requests made after its correction only', () => {
  const { recording, view } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  view.markFinished(seg);
  seg.src = 'Yes.';
  view.setText(seg, 'src', seg.src);
  recording.finalRequested('Yes.');
  seg.tgt = 'はい。';
  view.setText(seg, 'tgt', seg.tgt);
  assert.equal(recording.sentence(seg).settled, false);
  view.markFinished(seg);
  view.setText(seg, 'src', seg.src);
  view.setText(seg, 'tgt', seg.tgt);
  assert.equal(recording.sentence(seg).settled, true, 'no request since the correction');
});

test('lines are shown in the order of the targets, and the final translation is in when every line is', () => {
  const { recording, view, at } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  view.setText(seg, 'src', '안녕하세요');
  assert.equal(view.setTargets(seg, ['ja-JP', 'en-US']), true);
  assert.equal(view.setTargets(seg, ['ja-JP', 'en-US']), false, 'the same targets keep their lines');
  assert.deepEqual(seg.tgts, [
    { lang: 'ja-JP', text: '' },
    { lang: 'en-US', text: '' },
  ]);
  view.setLine(seg, 'en-US', 'Hello', 'pending');
  view.setLine(seg, 'ja-JP', 'こんにちは', 'pending');
  assert.equal(view.shownTranslation(seg, 'en-US'), 'Hello');
  assert.equal(view.shownTranslation(seg), 'こんにちは\nHello');
  at(2000);
  view.markFinished(seg);
  seg.src = '안녕하세요.';
  view.setText(seg, 'src', seg.src);
  seg.tgts[1].text = 'Hello.';
  view.setLine(seg, 'en-US', 'Hello.');
  assert.equal(recording.sentence(seg).finalShownAt, null, 'one line is still missing');
  seg.tgts[0].text = 'こんにちは。';
  at(2200);
  view.setLine(seg, 'ja-JP', 'こんにちは。');
  const s = recording.sentence(seg);
  assert.equal(s.finalShownAt, 2200);
  assert.equal(s.finalText, 'こんにちは。\nHello.');
  assert.deepEqual(
    s.displays.map((d) => d.text),
    ['Hello', 'こんにちは\nHello', 'こんにちは\nHello.', 'こんにちは。\nHello.'],
  );
});

test('after the lines are cleared their text stays shown until a single translation replaces it', () => {
  const { recording, view } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  view.setTargets(seg, ['ja-JP', 'en-US']);
  view.setLine(seg, 'ja-JP', 'こんにちは', 'pending');
  seg.lang = 'ko-KR';
  view.clearTargets(seg);
  assert.equal(seg.tgts, undefined);
  assert.equal(seg.lang, undefined);
  assert.equal(view.shownTranslation(seg), 'こんにちは');
  view.setText(seg, 'tgt', 'Hello', 'pending');
  assert.deepEqual(
    recording.sentence(seg).displays.map((d) => d.text),
    ['こんにちは', 'Hello'],
  );
});

test('an error is kept as the sentence error, not shown as a translation', () => {
  const { recording, view } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  view.markFinished(seg);
  view.setText(seg, 'tgt', 'offline', 'error');
  view.setTargets(seg, ['ja-JP', 'en-US']);
  view.setLine(seg, 'en-US', 'quota', 'error');
  const s = recording.sentence(seg);
  assert.equal(s.error, 'quota');
  assert.deepEqual(s.displays, []);
});

test('a sentence taken off the page is no longer mounted', () => {
  const { view } = setup();
  const seg = view.mount({ id: 1, src: '', tgt: '' }, true);
  view.placeBefore(seg, seg);
  view.tagSource(seg);
  view.unmount(seg);
  assert.equal(view.isMounted(seg), false);
});
