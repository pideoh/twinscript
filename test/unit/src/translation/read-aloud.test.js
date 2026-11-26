import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pickVoice,
  ReadAloud,
  readAloudHeard,
  readAloudInEffect,
  readAloudLanguages,
  speechLang,
} from '../../../../src/translation/read-aloud.js';

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

const PLACES = {
  browser: { desktop: false, platform: 'other' },
  'browser on Windows': { desktop: false, platform: 'windows' },
  'macOS app': { desktop: true, platform: 'mac' },
  'Windows app': { desktop: true, platform: 'windows' },
};

test('the Windows desktop app would hear what it reads aloud while PC audio is captured, and only then', () => {
  const heard = [];
  for (const [place, platform] of Object.entries(PLACES)) {
    for (const source of ['mic', 'system', 'both', 'file']) {
      if (readAloudHeard(platform, source)) heard.push(`${place} ${source}`);
    }
  }
  assert.deepEqual(heard, ['Windows app system', 'Windows app both']);
});

test('reading aloud is off while the app would hear itself, and the stored choice applies otherwise', () => {
  for (const choice of ['off', 'A', 'B', 'C', 'both']) {
    for (const [place, platform] of Object.entries(PLACES)) {
      for (const source of ['mic', 'system', 'both']) {
        const off = place === 'Windows app' && source !== 'mic';
        assert.equal(
          readAloudInEffect(choice, platform, source),
          off ? 'off' : choice,
          `${choice}, ${place}, ${source}`,
        );
      }
    }
  }
});

// A synthesizer that, like the browser's, says when it starts reading a sentence.
function startingSynth() {
  const fake = fakeSynth();
  const { speak } = fake.synth;
  fake.synth.speak = (u) => {
    speak(u);
    u.onstart?.();
  };
  return fake;
}

function listened(options = {}) {
  const { synth, Utterance } = startingSynth();
  const heard = [];
  const reader = new ReadAloud({
    synth,
    Utterance,
    onStart: (text, lang) => heard.push(['start', text, lang]),
    onEnd: (text) => heard.push(['end', text]),
    ...options,
  });
  return { synth, reader, heard };
}

test('the start and the end of each sentence read aloud are reported, in order', () => {
  const { synth, reader, heard } = listened();
  reader.speak('One.', 'en-US');
  reader.speak('二つ目。', 'ja-JP');
  assert.deepEqual(heard, [['start', 'One.', 'en-US']], 'the second one has not started');
  synth.finish();
  synth.finish();
  assert.deepEqual(heard, [
    ['start', 'One.', 'en-US'],
    ['end', 'One.'],
    ['start', '二つ目。', 'ja-JP'],
    ['end', '二つ目。'],
  ]);
});

test('a sentence that fails while being read is reported as ended', () => {
  const { synth, reader, heard } = listened();
  reader.speak('One.', 'en-US');
  synth.spoken[0].onerror();
  assert.deepEqual(heard, [
    ['start', 'One.', 'en-US'],
    ['end', 'One.'],
  ]);
});

test('a sentence cancelled by stopping is reported as ended at once, and only once', () => {
  const { synth, reader, heard } = listened();
  reader.speak('One.', 'en-US');
  reader.speak('Two.', 'en-US');
  reader.stop();
  synth.spoken[0].onerror?.(); // what cancel() reports for the interrupted sentence
  assert.deepEqual(heard, [
    ['start', 'One.', 'en-US'],
    ['end', 'One.'],
  ]);
});

test('a waiting sentence dropped before it was read is never reported, since nothing was heard', () => {
  const { synth, reader, heard } = listened();
  for (const s of ['One.', 'Two.', 'Three.', 'Four.']) reader.speak(s, 'en-US');
  synth.finish();
  synth.finish();
  synth.finish();
  assert.deepEqual(
    heard.filter(([, text]) => text === 'Two.'),
    [],
  );
  assert.equal(heard.length, 6);
});

test('a sentence the synthesizer never started is not reported when it ends', () => {
  const { synth, Utterance } = fakeSynth(); // reports no start
  const heard = [];
  const reader = new ReadAloud({ synth, Utterance, onEnd: (text) => heard.push(text) });
  reader.speak('One.', 'en-US');
  synth.spoken[0].onerror();
  reader.speak('Two.', 'en-US');
  reader.stop();
  assert.deepEqual(heard, []);
});
