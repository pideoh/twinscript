// The rules of the Questions tab: what it shows in each state, which key asks, which cited times
// become controls, what the field holds after a failure, how a question is quoted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answerPieces,
  asksOnKey,
  fieldAfterFailure,
  panelState,
  quotedQuestion,
  TIMES_LEFT_IN,
} from '../../../../src/ui/questions-panel.js';

const state = (over) =>
  panelState({ finished: true, running: false, asking: false, text: 'What was decided?', ...over });

test('a finished session with a question in the field can be asked', () => {
  assert.deepEqual(state(), {
    empty: false,
    note: '',
    fieldDisabled: false,
    askDisabled: false,
    stopShown: false,
  });
});

test('an empty or blank question cannot be asked', () => {
  assert.equal(state({ text: '' }).askDisabled, true);
  assert.equal(state({ text: '  \n\t ' }).askDisabled, true);
});

test('while an answer is on its way, Stop replaces Ask and nothing else can be asked; the field stays editable', () => {
  const s = state({ asking: true });
  assert.equal(s.stopShown, true);
  assert.equal(s.askDisabled, true);
  assert.equal(s.fieldDisabled, false);
});

test('while listening the field is disabled and a note says when questions can be asked', () => {
  const s = state({ running: true });
  assert.equal(s.empty, false, 'the tab can be opened while listening');
  assert.equal(s.note, 'questions.whileListening');
  assert.equal(s.fieldDisabled, true);
  assert.equal(s.askDisabled, true);
  assert.equal(state({ running: true, finished: false }).empty, false, 'even before anything is said');
});

test('a session without finished speech shows the empty state', () => {
  assert.equal(state({ finished: false }).empty, true);
});

test('Enter asks; Shift+Enter and the Enter that confirms an input method do not', () => {
  assert.equal(asksOnKey({ key: 'Enter' }), true);
  assert.equal(asksOnKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(asksOnKey({ key: 'Enter', isComposing: true }), false);
  assert.equal(asksOnKey({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(asksOnKey({ key: 'a' }), false);
});

const segments = [
  { elapsed: 1000, src: 'Shall we start?' },
  { elapsed: 6000, src: 'I will send the report on Friday.' },
  { elapsed: 11000, src: 'Good.' },
];

test('a cited time found in the transcript becomes a control for that line', () => {
  assert.deepEqual(answerPieces('The report goes out on Friday [00:00:06].', segments, 20_000), [
    { type: 'text', text: 'The report goes out on Friday [' },
    { type: 'time', text: '00:00:06', index: 1 },
    { type: 'text', text: '].' },
  ]);
});

test('several times in one bracket each become a control', () => {
  const pieces = answerPieces('[00:00:01, 00:00:11]', segments, 20_000);
  assert.deepEqual(
    pieces.filter((p) => p.type === 'time').map((p) => [p.text, p.index]),
    [
      ['00:00:01', 0],
      ['00:00:11', 2],
    ],
  );
});

test('a time that is not in the transcript stays text', () => {
  const text = 'Said before the start [00:00:00] and after the end [00:05:00].';
  assert.deepEqual(answerPieces(text, segments, 20_000), [{ type: 'text', text }]);
});

test('a time without brackets stays text', () => {
  const text = 'At 00:00:06 the report was promised.';
  assert.deepEqual(answerPieces(text, segments, 20_000), [{ type: 'text', text }]);
});

test('joining the pieces gives the text back', () => {
  const text = 'A [00:00:01] B [00:09:00] C [0:06; 00:00:11] D';
  assert.equal(
    answerPieces(text, segments, 20_000)
      .map((p) => p.text)
      .join(''),
    text,
  );
});

test('times inside code and links are left alone', () => {
  assert.deepEqual(TIMES_LEFT_IN.split(/,\s*/).sort(), ['a', 'code', 'pre']);
});

test('after a failed answer the field gets the question back, unless something new was typed', () => {
  assert.equal(fieldAfterFailure('', 'What was decided?'), 'What was decided?');
  assert.equal(fieldAfterFailure('  ', 'What was decided?'), 'What was decided?');
  assert.equal(fieldAfterFailure('Who is doing it?', 'What was decided?'), 'Who is doing it?');
});

test('the confirmation to delete quotes the question on one line, shortened', () => {
  assert.equal(quotedQuestion('What was\n decided?'), 'What was decided?');
  const long = quotedQuestion('x'.repeat(100), 10);
  assert.equal(long, `${'x'.repeat(9)}…`);
});
