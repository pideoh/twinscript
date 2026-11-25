import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canLabel,
  cleanSpeakerName,
  hasLabels,
  MAX_SPEAKER_NAME,
  numberByFirstLine,
  speakerName,
} from '../../../../src/session/speaker-labels.js';

const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : `[${key}]`);
const labelled = (speakers) => ({ speakerLabels: { speakers, madeAt: 1, uncertain: false, model: 'm' } });

test('only a session whose speakers were labelled shows speakers', () => {
  assert.equal(hasLabels(labelled([])), true);
  assert.equal(hasLabels(labelled([{ id: 's1', name: '' }])), true);
  assert.equal(hasLabels({}), false);
  assert.equal(hasLabels({ speakerLabels: {} }), false);
  assert.equal(hasLabels(null), false);
  assert.equal(hasLabels(undefined), false);
});

test('a speaker shows the name the user gave, else "Speaker n" by its place in the list', () => {
  const sess = labelled([
    { id: 's1', name: 'Aiko' },
    { id: 's2', name: '' },
  ]);
  assert.equal(speakerName(sess, 's1', t), 'Aiko');
  assert.equal(speakerName(sess, 's2', t), 'speakers.default {"n":2}');
});

test('a line without a speaker, or one not in the list, shows no name', () => {
  const sess = labelled([{ id: 's1', name: 'Aiko' }]);
  assert.equal(speakerName(sess, undefined, t), '');
  assert.equal(speakerName(sess, 's9', t), '');
  assert.equal(speakerName({}, 's1', t), '');
});

const finished = { segments: [{ src: '' }, { src: 'Hello' }], recordings: [{ durationMs: 5000 }] };

test('a stopped session with speech and a recording can be labelled', () => {
  assert.equal(canLabel(finished, false), true);
});

test('speakers cannot be labelled while listening, without speech or without a recording', () => {
  assert.equal(canLabel(finished, true), false);
  assert.equal(canLabel({ ...finished, segments: [{ src: '' }] }, false), false);
  assert.equal(canLabel({ ...finished, recordings: [] }, false), false);
  assert.equal(canLabel({ ...finished, recordings: [{ durationMs: 0 }] }, false), false);
});

test('speakers are not labelled in the demo, which has no engine for it', () => {
  assert.equal(canLabel(finished, false, true), false);
  assert.equal(canLabel(finished, false, false), true);
});

test('a speaker name is kept on one line,trimmed and cut to the longest name allowed', () => {
  assert.equal(cleanSpeakerName('  Aiko \n Tanaka\t'), 'Aiko Tanaka');
  assert.equal(cleanSpeakerName('   '), '');
  assert.equal(cleanSpeakerName('x'.repeat(MAX_SPEAKER_NAME + 5)).length, MAX_SPEAKER_NAME);
});

test('speakers are numbered by their first line and a speaker without lines is left out', () => {
  const { segmentSpeakers, speakers } = numberByFirstLine(['B', null, 'A', 'B', undefined, 'A']);
  assert.deepEqual(segmentSpeakers, ['s1', undefined, 's2', 's1', undefined, 's2']);
  assert.deepEqual(speakers, [
    { id: 's1', name: '' },
    { id: 's2', name: '' },
  ]);
});

test('when no line could be given a speaker, the session has an empty list of speakers', () => {
  assert.deepEqual(numberByFirstLine([null, null]), { segmentSpeakers: [undefined, undefined], speakers: [] });
});
