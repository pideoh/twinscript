import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { GeminiLiveTranscriber } from '../src/transcriber.js';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  // --- test helpers ---
  open() {
    this.readyState = 1;
    this.onopen();
  }
  receive(msg, binary = false) {
    const text = JSON.stringify(msg);
    this.onmessage({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
  drop(reason = '', code = 1006) {
    this.readyState = 3;
    this.onclose({ reason, code });
  }
  audio() {
    return this.sent.filter((m) => m.realtimeInput?.audio).map((m) => m.realtimeInput.audio.data);
  }
}
globalThis.WebSocket = FakeWebSocket;

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const log = { interim: [], final: [], state: [], errors: [] };
  const tr = new GeminiLiveTranscriber({
    apiKey: 'KEY',
    languageCodes: ['ja-JP', 'en-US'],
    smart: false,
    onInterim: (x) => log.interim.push(x),
    onFinal: (x) => log.final.push(x),
    onState: (x) => log.state.push(x),
    onError: (e) => log.errors.push(e),
    ...options,
  });
  tr.start();
  return { tr, log, sockets: FakeWebSocket.instances, tick: (ms) => t.mock.timers.tick(ms) };
}
beforeEach(() => {
  FakeWebSocket.instances = [];
});

test('sends the setup message and waits for setupComplete before streaming audio', (t) => {
  const { tr, log, sockets } = setup(t);
  const ws = sockets[0];
  assert.match(ws.url, /BidiGenerateContent\?key=KEY$/);
  ws.open();
  assert.deepEqual(ws.sent[0], {
    setup: {
      model: 'models/gemini-3.5-transcribe-live',
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: ['ja-JP', 'en-US'] },
    },
  });
  tr.sendAudio('a1');
  tr.sendAudio('a2');
  assert.deepEqual(ws.audio(), []);
  ws.receive({ setupComplete: {} });
  assert.deepEqual(ws.audio(), ['a1', 'a2']);
  tr.sendAudio('a3');
  assert.deepEqual(ws.audio(), ['a1', 'a2', 'a3']);
  assert.equal(ws.sent[1].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual(log.state, ['connecting', 'listening']);
  tr.stop();
});

test('starts streaming even if setupComplete never arrives', (t) => {
  const { tr, sockets, tick } = setup(t);
  sockets[0].open();
  tr.sendAudio('a1');
  tick(1500);
  assert.deepEqual(sockets[0].audio(), ['a1']);
  tr.stop();
});

test('SMART mode is requested when enabled', (t) => {
  const { tr, sockets } = setup(t, { smart: true });
  sockets[0].open();
  assert.equal(sockets[0].sent[0].setup.inputAudioTranscription.mode, 'SMART');
  tr.stop();
});

test('delivers interim and final text, from text or binary frames', (t) => {
  const { tr, log, sockets } = setup(t);
  const ws = sockets[0];
  ws.open();
  ws.receive({ setupComplete: {} });
  ws.receive({ serverContent: { interimInputTranscription: { text: 'こんに' } } });
  ws.receive({ serverContent: { inputTranscription: { text: ' こんにちは。 ' } } }, true);
  ws.receive({ serverContent: { inputTranscription: { text: '  ' } } });
  ws.onmessage({ data: 'not json' });
  assert.deepEqual(log.interim, ['こんに']);
  assert.deepEqual(log.final, ['こんにちは。']);
  tr.stop();
});

test('an invalid API key fails immediately without retrying', (t) => {
  const { log, sockets } = setup(t);
  sockets[0].open();
  sockets[0].drop('API key not valid. Please pass a valid API key.', 1007);
  assert.equal(sockets.length, 1);
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].key, 'error.connectFailed', 'reported with a UI message key');
  assert.match(log.errors[0].params.reason, /API key not valid/);
});

test('falls back to automatic language detection if setup is rejected', (t) => {
  const { tr, log, sockets } = setup(t);
  sockets[0].open();
  sockets[0].drop('Invalid argument', 1007);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent[0].setup.inputAudioTranscription.languageCodes, []);
  assert.deepEqual(log.errors, []);
  tr.stop();
});

test('reconnects after a drop and replays audio buffered meanwhile', (t) => {
  const { tr, log, sockets, tick } = setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  sockets[0].drop();
  assert.equal(log.state.at(-1), 'reconnecting');
  tr.sendAudio('during-outage');
  tick(500);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].receive({ setupComplete: {} });
  assert.deepEqual(sockets[1].audio(), ['during-outage']);
  assert.equal(log.state.at(-1), 'listening');
  tr.stop();
});

test('gives up after repeated failed reconnects', (t) => {
  const { log, sockets, tick } = setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  sockets[0].drop();
  for (let i = 0; i < 10 && !log.errors.length; i++) {
    tick(8000);
    sockets.at(-1).drop();
  }
  assert.equal(log.errors.length, 1);
  assert.deepEqual([log.errors[0].key, log.errors[0].params], ['error.disconnectedCode', { code: 1006 }]);
  const count = sockets.length;
  tick(60_000);
  assert.equal(sockets.length, count, 'no further attempts after giving up');
});

test('rotates to a fresh session before the 10 minute limit without losing results', (t) => {
  const { tr, log, sockets, tick } = setup(t);
  const first = sockets[0];
  first.open();
  first.receive({ setupComplete: {} });
  tick(9.5 * 60 * 1000);
  assert.equal(sockets.length, 2, 'a second session is opened in the background');
  const second = sockets[1];
  tr.sendAudio('before-switch');
  assert.deepEqual(first.audio(), ['before-switch'], 'audio keeps going to the old session until the new one is ready');
  second.open();
  second.receive({ setupComplete: {} });
  tr.sendAudio('after-switch');
  assert.deepEqual(second.audio(), ['after-switch']);
  assert.deepEqual(first.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  first.receive({ serverContent: { inputTranscription: { text: 'tail of the old session' } } });
  assert.deepEqual(log.final, ['tail of the old session']);
  assert.equal(first.readyState, 1);
  tick(4000);
  assert.equal(first.readyState, 3, 'the old session is closed after it had time to flush');
  first.onclose({ reason: '', code: 1000 });
  assert.equal(sockets.length, 2, 'closing the retired session does not trigger a reconnect');
  tr.stop();
});

test('rotates at the next pause once the session is old enough', (t) => {
  const { tr, sockets, tick } = setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  tick(8.5 * 60 * 1000 + 1);
  assert.equal(sockets.length, 1);
  sockets[0].receive({ serverContent: { inputTranscription: { text: 'a pause' } } });
  assert.equal(sockets.length, 2);
  tr.stop();
});

test('stop closes the session and ignores later audio', (t) => {
  const { tr, sockets } = setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  tr.stop();
  assert.deepEqual(sockets[0].sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  assert.equal(sockets[0].readyState, 3);
  tr.sendAudio('late');
  assert.deepEqual(sockets[0].audio(), []);
  assert.equal(tr.pending.length, 0);
});
