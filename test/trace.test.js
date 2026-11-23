import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTrace, traceFileName } from '../src/trace.js';

const fakeClock = (start = 1000) => {
  const clock = { ms: start, now: () => clock.ms };
  return clock;
};
const START = new Date('2026-11-23T01:02:03.456Z');

test('a trace records each result with whole milliseconds since the run started', () => {
  const clock = fakeClock(5000.25);
  const trace = createTrace({ langs: ['ja-JP', 'en-US'], source: 'mic', now: clock.now, date: () => START });
  clock.ms = 5120.6;
  trace.add('interim', 'Hello');
  clock.ms = 5900.4;
  trace.add('final', 'Hello everyone.');
  assert.deepEqual(trace.toJSON().events, [
    { t: 120, kind: 'interim', text: 'Hello' },
    { t: 900, kind: 'final', text: 'Hello everyone.' },
  ]);
});

test('a trace has the documented shape', () => {
  const clock = fakeClock();
  const trace = createTrace({ langs: ['ja-JP', 'en-US', 'zh-CN'], source: 'file', now: clock.now, date: () => START });
  clock.ms += 50;
  trace.add('final', 'x');
  clock.ms += 50;
  trace.end();
  assert.deepEqual(trace.toJSON(), {
    version: 1,
    startedAt: '2026-11-23T01:02:03.456Z',
    langs: ['ja-JP', 'en-US', 'zh-CN'],
    source: 'file',
    events: [{ t: 50, kind: 'final', text: 'x' }],
    durationMs: 100,
  });
  // It survives a JSON round trip unchanged, which is how it is downloaded.
  assert.deepEqual(JSON.parse(JSON.stringify(trace)), trace.toJSON());
});

test('a trace keeps the recognizer text exactly as it came, spaces and all', () => {
  const trace = createTrace({ now: fakeClock().now });
  const raw = ' ええと、 それは  gemini の話で\n';
  trace.add('interim', raw);
  assert.equal(trace.toJSON().events[0].text, raw);
});

test('ending a trace fixes its duration and stops recording', () => {
  const clock = fakeClock();
  const trace = createTrace({ now: clock.now });
  clock.ms += 1500;
  assert.equal(trace.toJSON().durationMs, 1500); // still running: the time so far
  trace.end();
  clock.ms += 1000;
  trace.add('final', 'late');
  trace.end();
  const json = trace.toJSON();
  assert.equal(json.durationMs, 1500);
  assert.deepEqual(json.events, []);
});

test('the copy a trace hands out cannot change it', () => {
  const trace = createTrace({ langs: ['en-US'], now: fakeClock().now });
  trace.add('final', 'a');
  const json = trace.toJSON();
  json.events[0].text = 'changed';
  json.langs.push('ja-JP');
  assert.equal(trace.toJSON().events[0].text, 'a');
  assert.deepEqual(trace.toJSON().langs, ['en-US']);
});

test('a trace file is named after its local start time', () => {
  assert.equal(traceFileName(new Date(2026, 0, 5, 9, 7, 3)), 'twinscript-trace-20260105-090703.json');
});
