import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fileFigures,
  formatRanges,
  lineCoverage,
  mergeStates,
  offsetStates,
  sourcePath,
  total,
  uncoveredRanges,
} from '../../../scripts/e2e-coverage.mjs';

const range = (startOffset, endOffset, count) => ({ startOffset, endOffset, count });
const states = (functions, length) => [...offsetStates(functions, length)];

test('each character takes the count of the innermost range around it', () => {
  const functions = [
    { ranges: [range(0, 10, 1), range(2, 6, 0)] },
    { ranges: [range(3, 5, 4)] }, // a function inside the unrun block that ran (as a callback would)
  ];
  assert.deepEqual(states(functions, 12), [1, 1, 0, 1, 1, 0, 1, 1, 1, 1, -1, -1]);
});

test('a range reaching past the source is cut at its end', () => {
  assert.deepEqual(states([{ ranges: [range(0, 99, 1)] }], 3), [1, 1, 1]);
});

test('a character ran when any page ran it', () => {
  const a = offsetStates([{ ranges: [range(0, 4, 1), range(1, 3, 0)] }], 5);
  const b = offsetStates([{ ranges: [range(0, 4, 1), range(2, 4, 0)] }], 5);
  assert.deepEqual([...mergeStates(a, b)], [1, 1, 0, 1, -1], 'character 2 ran in neither page');
});

test('a line is covered only when all its code ran; blank, comment and bracket lines are not counted', () => {
  const source = [
    'const a = 1;', // 1 ran
    '', // 2 blank
    '// a comment', // 3
    '/* a block', // 4
    '   comment */', // 5
    'if (a) {', // 6 ran
    '  b();', // 7 did not run
    '}', // 8 bracket only
    '  });', // 9 bracket only
    'c(); d();', // 10 half ran
  ].join('\n');
  const st = new Int8Array(source.length).fill(1);
  const at = (text) => source.indexOf(text);
  st.fill(0, at('  b();'), at('  b();') + 6);
  st.fill(0, at('d();'), at('d();') + 4);
  assert.deepEqual(lineCoverage(source, st), [true, null, null, null, null, true, false, null, null, false]);
});

test('a file no page loaded has every line with code uncovered', () => {
  const source = 'export const a = 1;\r\n\r\nexport function b() {\r\n  return a;\r\n}\r\n';
  const lines = lineCoverage(source, new Int8Array(source.length).fill(-1));
  assert.deepEqual(lines, [false, null, false, false, null, null]);
  assert.deepEqual(fileFigures('src/x.js', lines), {
    file: 'src/x.js',
    lines: 3,
    covered: 0,
    percent: 0,
    uncovered: [[1, 4]],
  });
});

test('uncovered lines become ranges, and lines without code between them do not split a range', () => {
  assert.deepEqual(uncoveredRanges([true, false, false, null, false, true, false, null, true, null, false]), [
    [2, 5],
    [7, 7],
    [11, 11],
  ]);
  assert.deepEqual(uncoveredRanges([true, null, true]), []);
});

test('the uncovered ranges are shown compressed, with how many more there are past the limit', () => {
  assert.equal(
    formatRanges([
      [1, 3],
      [7, 7],
    ]),
    '1-3 7',
  );
  const many = Array.from({ length: 13 }, (_, i) => [i * 10, i * 10]);
  assert.equal(formatRanges(many, 3), '0 10 20 … +10 more');
});

test('the total counts lines across files, not the mean of their percentages', () => {
  const sum = total([
    { lines: 100, covered: 90 },
    { lines: 10, covered: 0 },
  ]);
  assert.deepEqual(sum, { lines: 110, covered: 90, percent: (90 / 110) * 100 });
  assert.equal(total([]).percent, 100);
});

test('only the app’s own scripts under /src/ are counted', () => {
  assert.equal(sourcePath('http://127.0.0.1:5000/src/ui/i18n.js'), 'src/ui/i18n.js');
  assert.equal(sourcePath('http://127.0.0.1:5000/src/app.js?v=1'), 'src/app.js');
  assert.equal(sourcePath('http://127.0.0.1:5000/test/e2e/x.js'), null);
  assert.equal(sourcePath(''), null);
  assert.equal(sourcePath('http://127.0.0.1:5000/index.html'), null);
});
