import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickVoice, ReadAloud, readAloudLanguages, speechLang } from '../src/read-aloud.js';

// A synthesizer that reads nothing: it keeps what it was given and finishes on request.
function fakeSynth(voices = []) {
  const synth = {
    spoken: [],
    cancelled: 0,
    getVoices: () => voices,
    speak(u) {
      synth.spoken.push(u);
    },
    cancel() {
      synth.cancelled++;
    },
    finish() {
      synth.spoken.at(-1).onend?.();
    },
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  return { synth, Utterance };
}

test('sentences are read one after another, in order', () => {
  const { synth, Utterance } = fakeSynth();
  const reader = new ReadAloud({ synth, Utterance });
  reader.speak('One.', 'en-US');
  reader.speak('Two.', 'en-US');
  assert.deepEqual(
    synth.spoken.map((u) => u.text),
    ['One.'],
    'the next one waits for the first to end',
  );
  synth.finish();
  assert.deepEqual(
    synth.spoken.map((u) => u.text),
    ['One.', 'Two.'],
  );
});

test('the voice never falls more than two sentences behind: the oldest waiting one is dropped', () => {
  const { synth, Utterance } = fakeSynth();
  const reader = new ReadAloud({ synth, Utterance });
  for (const s of ['One.', 'Two.', 'Three.', 'Four.']) reader.speak(s, 'en-US');
  synth.finish();
  synth.finish();
  synth.finish();
  assert.deepEqual(
    synth.spoken.map((u) => u.text),
    ['One.', 'Three.', 'Four.'],
  );
});

test('a sentence that fails to be read does not hold up the next one', () => {
  const { synth, Utterance } = fakeSynth();
  const reader = new ReadAloud({ synth, Utterance });
  reader.speak('One.', 'en-US');
  reader.speak('Two.', 'en-US');
  synth.spoken[0].onerror();
  assert.equal(synth.spoken.length, 2);
});

test('stopping silences the voice at once and forgets what was waiting', () => {
  const { synth, Utterance } = fakeSynth();
  const reader = new ReadAloud({ synth, Utterance });
  reader.speak('One.', 'en-US');
  reader.speak('Two.', 'en-US');
  reader.stop();
  assert.equal(synth.cancelled, 1);
  synth.spoken[0].onerror?.(); // what cancel() reports for the interrupted sentence
  assert.equal(synth.spoken.length, 1, 'nothing more is read');
  reader.speak('Three.', 'en-US');
  assert.deepEqual(
    synth.spoken.map((u) => u.text),
    ['One.', 'Three.'],
    'reading starts again with the next sentence',
  );
});

test('each sentence is read in its language, with a voice for it when the system has one', () => {
  const voices = [
    { name: 'US', lang: 'en-US' },
    { name: 'UK', lang: 'en-GB' },
    { name: 'Kyoko', lang: 'ja-JP' },
    { name: 'Mei-Jia', lang: 'zh-TW' },
    { name: 'Tingting', lang: 'zh_CN' },
  ];
  const { synth, Utterance } = fakeSynth(voices);
  const reader = new ReadAloud({ synth, Utterance, maxWaiting: 10 });
  for (const code of ['ja-JP', 'cmn-Hans-CN', 'cmn-Hant-TW', 'fr-FR']) {
    reader.speak('text', code);
    synth.finish();
  }
  assert.deepEqual(
    synth.spoken.map((u) => [u.lang, u.voice?.name]),
    [
      ['ja-JP', 'Kyoko'],
      ['zh-CN', 'Tingting'],
      ['zh-TW', 'Mei-Jia'],
      ['fr-FR', undefined],
    ],
  );
});

test('a voice of the same language is used when none matches the region', () => {
  const voices = [
    { name: 'UK', lang: 'en-GB' },
    { name: 'US', lang: 'en-US' },
  ];
  assert.equal(pickVoice(voices, 'en-US').name, 'US', 'the exact region first');
  assert.equal(pickVoice(voices, 'en-AU').name, 'UK');
  assert.equal(pickVoice(voices, 'pt-BR'), null);
});

test('Chinese is given to the voices under the tags they use', () => {
  assert.equal(speechLang('cmn-Hans-CN'), 'zh-CN');
  assert.equal(speechLang('cmn-Hant-TW'), 'zh-TW');
  assert.equal(speechLang('ja-JP'), 'ja-JP');
});

test('without speech synthesis nothing is read and nothing fails', () => {
  const reader = new ReadAloud({ synth: undefined, Utterance: undefined });
  assert.equal(reader.available, false);
  reader.speak('One.', 'en-US');
  reader.stop();
});

test('empty translations are not read', () => {
  const { synth, Utterance } = fakeSynth();
  const reader = new ReadAloud({ synth, Utterance });
  reader.speak('  ', 'en-US');
  reader.speak('', 'en-US');
  assert.equal(synth.spoken.length, 0);
});

test('with two languages, translations into one of them or into both are read', () => {
  const langs = ['ja-JP', 'en-US'];
  assert.deepEqual(readAloudLanguages('A', langs), ['ja-JP']);
  assert.deepEqual(readAloudLanguages('B', langs), ['en-US']);
  assert.deepEqual(readAloudLanguages('both', langs), ['ja-JP', 'en-US']);
  assert.deepEqual(readAloudLanguages('off', langs), []);
});

test('with three languages, translations into the chosen one only are read', () => {
  const langs = ['ja-JP', 'en-US', 'cmn-Hans-CN'];
  assert.deepEqual(readAloudLanguages('A', langs), ['ja-JP']);
  assert.deepEqual(readAloudLanguages('B', langs), ['en-US']);
  assert.deepEqual(readAloudLanguages('C', langs), ['cmn-Hans-CN']);
  assert.deepEqual(readAloudLanguages('off', langs), []);
});

test('a choice that does not fit the languages selected reads nothing', () => {
  assert.deepEqual(readAloudLanguages('both', ['ja-JP', 'en-US', 'cmn-Hans-CN']), [], 'both, with three languages');
  assert.deepEqual(readAloudLanguages('C', ['ja-JP', 'en-US']), [], 'the third, with two languages');
  assert.deepEqual(readAloudLanguages('X', ['ja-JP', 'en-US']), []);
  assert.deepEqual(readAloudLanguages(undefined, ['ja-JP', 'en-US']), []);
});
