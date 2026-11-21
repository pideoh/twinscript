import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyReplacements, MAX_TERMS, parseVocabulary } from '../src/vocabulary.js';

test('each line becomes a term for the recognizer, ignoring blank lines and surrounding spaces', () => {
  assert.deepEqual(parseVocabulary('  Twinscript \n\n\tKubernetes\r\n   \n'), {
    terms: ['Twinscript', 'Kubernetes'],
    rules: [],
  });
  assert.deepEqual(parseVocabulary(''), { terms: [], rules: [] });
  assert.deepEqual(parseVocabulary(undefined), { terms: [], rules: [] });
});

test('a "wrong => right" line corrects the transcript and teaches the recognizer the right word', () => {
  assert.deepEqual(
    parseVocabulary('twin script => Twinscript\nkube=>Kubernetes\n  ツインスクリプト   =>   Twinscript  '),
    {
      terms: ['Twinscript', 'Kubernetes'],
      rules: [
        { from: 'twin script', to: 'Twinscript' },
        { from: 'kube', to: 'Kubernetes' },
        { from: 'ツインスクリプト', to: 'Twinscript' },
      ],
    },
  );
});

test('a rule with nothing on one side is ignored', () => {
  assert.deepEqual(parseVocabulary('=> Twinscript\ntwin script =>\n=>\nGemini'), { terms: ['Gemini'], rules: [] });
});

test('only the first "=>" separates a rule', () => {
  assert.deepEqual(parseVocabulary('a => b => c').rules, [{ from: 'a', to: 'b => c' }]);
});

test('a term listed twice is sent once', () => {
  assert.deepEqual(parseVocabulary('Gemini\nGemini\ngemini\njemini => Gemini').terms, ['Gemini', 'gemini']);
});

test('the recognizer gets at most 1,000 terms, the first ones listed', () => {
  const lines = Array.from({ length: MAX_TERMS + 5 }, (_, i) => `term${i}`);
  const { terms } = parseVocabulary(lines.join('\n'));
  assert.equal(MAX_TERMS, 1000);
  assert.equal(terms.length, 1000);
  assert.equal(terms[0], 'term0');
  assert.equal(terms.at(-1), 'term999');
});

test('rules still correct the transcript beyond the 1,000-term limit', () => {
  const lines = Array.from({ length: MAX_TERMS }, (_, i) => `term${i}`);
  lines.push('foo => bar');
  const { terms, rules } = parseVocabulary(lines.join('\n'));
  assert.equal(terms.length, 1000);
  assert.ok(!terms.includes('bar'));
  assert.deepEqual(rules, [{ from: 'foo', to: 'bar' }]);
});

test('corrections apply to every occurrence regardless of letter case', () => {
  const rules = [{ from: 'twin script', to: 'Twinscript' }];
  assert.equal(
    applyReplacements('Twin Script is new. I like twin script.', rules),
    'Twinscript is new. I like Twinscript.',
  );
});

test('corrections match the text literally, including characters like + . * $', () => {
  assert.equal(applyReplacements('I write c++ and C++.', [{ from: 'c++', to: 'C++' }]), 'I write C++ and C++.');
  assert.equal(applyReplacements('a.*b and axxb', [{ from: '.*', to: '-' }]), 'a-b and axxb');
  assert.equal(
    applyReplacements('cost (USD)', [{ from: '(USD)', to: '$&' }]),
    'cost $&',
    'the replacement is literal too',
  );
  assert.equal(
    applyReplacements('a|b [x] \\d', [
      { from: '[x]', to: 'X' },
      { from: '\\d', to: 'D' },
    ]),
    'a|b X D',
  );
});

test('the longer of two overlapping corrections wins', () => {
  const rules = [
    { from: 'script', to: 'SCRIPT' },
    { from: 'twin script', to: 'Twinscript' },
  ];
  assert.equal(applyReplacements('twin script and script', rules), 'Twinscript and SCRIPT');
});

test('a correction is not rewritten again by another rule', () => {
  const rules = [
    { from: 'kube', to: 'Kubernetes' },
    { from: 'net', to: 'NET' },
  ];
  assert.equal(applyReplacements('kube on .net', rules), 'Kubernetes on .NET');
});

test('equal-length corrections apply in the order listed', () => {
  const rules = [
    { from: 'ab', to: '1' },
    { from: 'AB', to: '2' },
  ];
  assert.equal(applyReplacements('ab AB', rules), '1 1');
});

test('corrections work in Japanese and Chinese text', () => {
  assert.equal(
    applyReplacements('ツインスクリプトで会議を記録。ツインスクリプトは便利。', [
      { from: 'ツインスクリプト', to: 'Twinscript' },
    ]),
    'Twinscriptで会議を記録。Twinscriptは便利。',
  );
  assert.equal(
    applyReplacements('我们用双子脚本开会', [{ from: '双子脚本', to: 'Twinscript' }]),
    '我们用Twinscript开会',
  );
});

test('without rules the text is unchanged', () => {
  assert.equal(applyReplacements('hello', []), 'hello');
  assert.equal(applyReplacements('', [{ from: 'a', to: 'b' }]), '');
});
