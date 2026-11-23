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

// The token service. `respond(callNumber)` returns { status, body } or throws (a network error);
// it may also return a promise to hold the request open.
const tokenRequests = [];
let respond;
const tokenFor = (n) => `auth_tokens/token-${n}`;
const grantTokens = (n) => ({ status: 200, body: { name: tokenFor(n) } });
globalThis.fetch = async (url, init) => {
  tokenRequests.push({ url, init });
  const { status, body } = await respond(tokenRequests.length);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const LIVE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t, options = {}) {
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
  await settle();
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { tr, log, sockets: FakeWebSocket.instances, tick };
}
beforeEach(() => {
  FakeWebSocket.instances = [];
  tokenRequests.length = 0;
  respond = grantTokens;
});

test('sends the setup message and waits for setupComplete before streaming audio', async (t) => {
  const { tr, log, sockets } = await setup(t);
  const ws = sockets[0];
  assert.equal(ws.url, `${LIVE}Constrained?access_token=auth_tokens%2Ftoken-1`);
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

test('starts streaming even if setupComplete never arrives', async (t) => {
  const { tr, sockets, tick } = await setup(t);
  sockets[0].open();
  tr.sendAudio('a1');
  await tick(1500);
  assert.deepEqual(sockets[0].audio(), ['a1']);
  tr.stop();
});

test('SMART mode is requested when enabled', async (t) => {
  const { tr, sockets } = await setup(t, { smart: true });
  sockets[0].open();
  assert.equal(sockets[0].sent[0].setup.inputAudioTranscription.mode, 'SMART');
  tr.stop();
});

test('custom terms are sent to the recognizer', async (t) => {
  const { tr, sockets } = await setup(t, { customVocabulary: ['Twinscript', 'Kubernetes'] });
  sockets[0].open();
  assert.deepEqual(sockets[0].sent[0].setup.inputAudioTranscription, {
    languageCodes: ['ja-JP', 'en-US'],
    customVocabulary: ['Twinscript', 'Kubernetes'],
  });
  tr.stop();
});

test('no term list is sent when the user gave no terms', async (t) => {
  const { tr, sockets } = await setup(t, { customVocabulary: [] });
  sockets[0].open();
  assert.ok(!('customVocabulary' in sockets[0].sent[0].setup.inputAudioTranscription));
  tr.stop();
});

test('if setup with custom terms is rejected, transcription continues once without them', async (t) => {
  const { tr, log, sockets } = await setup(t, { customVocabulary: ['Twinscript'] });
  sockets[0].open();
  sockets[0].drop('Invalid argument', 1007);
  await settle();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  const first = sockets[1].sent[0].setup.inputAudioTranscription;
  assert.ok(!('customVocabulary' in first), 'the terms are dropped first');
  assert.deepEqual(first.languageCodes, ['ja-JP', 'en-US'], 'the language hint is kept');
  sockets[1].drop('Invalid argument', 1007);
  await settle();
  assert.equal(sockets.length, 3);
  sockets[2].open();
  assert.deepEqual(sockets[2].sent[0].setup.inputAudioTranscription, { languageCodes: [] }, 'then the language hint');
  sockets[2].receive({ setupComplete: {} });
  assert.deepEqual(log.errors, []);
  assert.equal(log.state.at(-1), 'listening');
  tr.stop();
});

test('custom terms do not delay the error for an invalid API key', async (t) => {
  const { log, sockets } = await setup(t, { customVocabulary: ['Twinscript'] });
  sockets[0].open();
  sockets[0].drop('API key not valid. Please pass a valid API key.', 1007);
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(log.errors[0].key, 'error.connectFailed');
});

test('custom terms are kept when a working session reconnects', async (t) => {
  const { tr, sockets, tick } = await setup(t, { customVocabulary: ['Twinscript'] });
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  sockets[0].drop();
  await settle();
  await tick(500);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent[0].setup.inputAudioTranscription.customVocabulary, ['Twinscript']);
  tr.stop();
});

test('delivers interim and final text, from text or binary frames', async (t) => {
  const { tr, log, sockets } = await setup(t);
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

test('an invalid API key fails immediately without retrying', async (t) => {
  const { log, sockets } = await setup(t);
  sockets[0].open();
  sockets[0].drop('API key not valid. Please pass a valid API key.', 1007);
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].key, 'error.connectFailed', 'reported with a UI message key');
  assert.match(log.errors[0].params.reason, /API key not valid/);
});

test('falls back to automatic language detection if setup is rejected', async (t) => {
  const { tr, log, sockets } = await setup(t);
  sockets[0].open();
  sockets[0].drop('Invalid argument', 1007);
  await settle();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent[0].setup.inputAudioTranscription.languageCodes, []);
  assert.deepEqual(log.errors, []);
  tr.stop();
});

test('reconnects after a drop and replays audio buffered meanwhile', async (t) => {
  const { tr, log, sockets, tick } = await setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  sockets[0].drop();
  await settle();
  assert.equal(log.state.at(-1), 'reconnecting');
  tr.sendAudio('during-outage');
  await tick(500);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].receive({ setupComplete: {} });
  assert.deepEqual(sockets[1].audio(), ['during-outage']);
  assert.equal(log.state.at(-1), 'listening');
  tr.stop();
});

test('gives up after repeated failed reconnects', async (t) => {
  const { log, sockets, tick } = await setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  sockets[0].drop();
  await settle();
  for (let i = 0; i < 10 && !log.errors.length; i++) {
    await tick(8000);
    sockets.at(-1).drop();
    await settle();
  }
  assert.equal(log.errors.length, 1);
  assert.deepEqual([log.errors[0].key, log.errors[0].params], ['error.disconnectedCode', { code: 1006 }]);
  const count = sockets.length;
  await tick(60_000);
  assert.equal(sockets.length, count, 'no further attempts after giving up');
});

test('rotates to a fresh session before the 10 minute limit without losing results', async (t) => {
  const { tr, log, sockets, tick } = await setup(t);
  const first = sockets[0];
  first.open();
  first.receive({ setupComplete: {} });
  await tick(9.5 * 60 * 1000);
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
  await tick(4000);
  assert.equal(first.readyState, 3, 'the old session is closed after it had time to flush');
  first.onclose({ reason: '', code: 1000 });
  assert.equal(sockets.length, 2, 'closing the retired session does not trigger a reconnect');
  tr.stop();
});

test('rotates at the next pause once the session is old enough', async (t) => {
  const { tr, sockets, tick } = await setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  await tick(8.5 * 60 * 1000 + 1);
  assert.equal(sockets.length, 1);
  sockets[0].receive({ serverContent: { inputTranscription: { text: 'a pause' } } });
  await settle();
  assert.equal(sockets.length, 2);
  tr.stop();
});

test('stop closes the session and ignores later audio', async (t) => {
  const { tr, sockets } = await setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  tr.stop();
  assert.deepEqual(sockets[0].sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  assert.equal(sockets[0].readyState, 3);
  tr.sendAudio('late');
  assert.deepEqual(sockets[0].audio(), []);
  assert.equal(tr.pending.length, 0);
});

test('the API key travels only in a request header, never in an address', async (t) => {
  const { tr, sockets } = await setup(t);
  assert.equal(tokenRequests.length, 1);
  const [{ url, init }] = tokenRequests;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/auth_tokens');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], 'KEY');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, '{}', 'no constraints are sent with the token request');
  assert.ok(!url.includes('KEY'));
  assert.ok(!sockets[0].url.includes('KEY'));
  assert.match(sockets[0].url, /\.BidiGenerateContentConstrained\?access_token=/);
  tr.stop();
});

test('every connection, reconnect and rotation gets a token of its own', async (t) => {
  const { tr, sockets, tick } = await setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  sockets[0].drop();
  await settle();
  await tick(500);
  sockets[1].open();
  sockets[1].receive({ setupComplete: {} });
  await tick(9.5 * 60 * 1000);
  assert.equal(sockets.length, 3);
  assert.equal(tokenRequests.length, 3);
  assert.deepEqual(
    sockets.map((s) => new URL(s.url).searchParams.get('access_token')),
    [tokenFor(1), tokenFor(2), tokenFor(3)],
  );
  assert.ok(sockets.every((s) => !s.url.includes('KEY')));
  tr.stop();
});

test('the rotation asks for its token while the current session keeps transcribing', async (t) => {
  let release;
  const { tr, log, sockets, tick } = await setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  respond = () =>
    new Promise((resolve) => {
      release = () => resolve(grantTokens(2));
    });
  await tick(9.5 * 60 * 1000);
  assert.equal(tokenRequests.length, 2, 'the token is requested as soon as the rotation starts');
  tr.sendAudio('while-waiting');
  assert.deepEqual(sockets[0].audio(), ['while-waiting']);
  release();
  await settle();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].receive({ setupComplete: {} });
  tr.sendAudio('after-switch');
  assert.deepEqual(sockets[1].audio(), ['after-switch']);
  assert.deepEqual(log.errors, []);
  tr.stop();
});

for (const [name, answer] of [
  ['the token service cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['the token service does not exist', () => ({ status: 404, body: { error: { message: 'Not found' } } })],
  ['the token service rejects the request', () => ({ status: 400, body: { error: { message: 'Unknown name' } } })],
]) {
  test(`if ${name}, the meeting still starts, with the key in the address`, async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    respond = answer;
    const { tr, log, sockets, tick } = await setup(t);
    assert.equal(sockets.length, 1);
    assert.match(sockets[0].url, /\.BidiGenerateContent\?key=KEY$/);
    sockets[0].open();
    sockets[0].receive({ setupComplete: {} });
    assert.equal(log.state.at(-1), 'listening');
    assert.deepEqual(log.errors, []);
    assert.equal(warnings.mock.callCount(), 1);
    const warning = warnings.mock.calls[0].arguments.join(' ');
    assert.match(warning, /token/);
    assert.ok(!warning.includes('KEY'), 'the warning does not show the key');
    sockets[0].drop();
    await settle();
    await tick(500);
    assert.equal(tokenRequests.length, 1, 'no further token requests in this session');
    assert.match(sockets[1].url, /\.BidiGenerateContent\?key=KEY$/);
    assert.equal(warnings.mock.callCount(), 1, 'warned once');
    tr.stop();
  });
}

test('the fallback warning never repeats the key, even if the service echoes it', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  respond = () => ({ status: 501, body: { error: { message: 'Not implemented for KEY' } } });
  const { tr } = await setup(t);
  const warning = warnings.mock.calls[0].arguments.join(' ');
  assert.match(warning, /HTTP 501/);
  assert.ok(!warning.includes('KEY'));
  tr.stop();
});

for (const [status, message] of [
  [400, 'API key not valid. Please pass a valid API key.'],
  [403, 'Permission denied'],
  [401, 'Request is missing required authentication credential.'],
]) {
  test(`a key the token service refuses (HTTP ${status}) is reported without retrying`, async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    respond = () => ({ status, body: { error: { message } } });
    const { log, sockets, tick } = await setup(t, { customVocabulary: ['Twinscript'] });
    assert.equal(sockets.length, 0, 'no connection is made');
    assert.equal(log.errors.length, 1);
    assert.deepEqual([log.errors[0].key, log.errors[0].params], ['error.connectFailed', { reason: message }]);
    assert.equal(warnings.mock.callCount(), 0);
    await tick(60_000);
    assert.equal(tokenRequests.length, 1);
  });
}

test('a used-up token is replaced with a new one, keeping the language hint and terms', async (t) => {
  const { tr, log, sockets, tick } = await setup(t, { customVocabulary: ['Twinscript'] });
  sockets[0].open();
  sockets[0].drop('Token has been used too many times', 1011);
  await settle();
  assert.deepEqual(log.errors, []);
  assert.equal(log.state.at(-1), 'reconnecting');
  await tick(500);
  assert.equal(sockets.length, 2);
  assert.equal(new URL(sockets[1].url).searchParams.get('access_token'), tokenFor(2));
  sockets[1].open();
  assert.deepEqual(sockets[1].sent[0].setup.inputAudioTranscription, {
    languageCodes: ['ja-JP', 'en-US'],
    customVocabulary: ['Twinscript'],
  });
  sockets[1].receive({ setupComplete: {} });
  assert.equal(log.state.at(-1), 'listening');
  tr.stop();
});

test('a token request that fails for a while is retried like a dropped connection', async (t) => {
  const unavailable = { status: 503, body: { error: { message: 'The service is currently unavailable.' } } };
  respond = (n) => (n === 1 ? unavailable : grantTokens(n));
  const { tr, log, sockets, tick } = await setup(t);
  assert.equal(sockets.length, 0);
  assert.equal(log.state.at(-1), 'reconnecting');
  await tick(500);
  assert.equal(sockets.length, 1);
  assert.equal(new URL(sockets[0].url).searchParams.get('access_token'), tokenFor(2));
  sockets[0].open();
  assert.deepEqual(sockets[0].sent[0].setup.inputAudioTranscription.languageCodes, ['ja-JP', 'en-US']);
  assert.deepEqual(log.errors, []);
  tr.stop();
});

test('stopping while a token is on its way opens no connection', async (t) => {
  let release;
  respond = () =>
    new Promise((resolve) => {
      release = () => resolve(grantTokens(1));
    });
  const { tr, log, sockets } = await setup(t);
  tr.stop();
  release();
  await settle();
  assert.equal(sockets.length, 0);
  assert.deepEqual(log.errors, []);
});

test('once tokens have worked, a network outage while reconnecting does not put the key in the address', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  // The first token is granted; the next request cannot be made (as during a short outage).
  respond = (n) => {
    if (n === 2) throw new TypeError('Failed to fetch');
    return grantTokens(n);
  };
  const { tr, log, sockets, tick } = await setup(t);
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  sockets[0].drop();
  await settle();
  await tick(500); // the retry asks for a token and fails
  await settle();
  await tick(1000); // the next retry gets one
  await settle();
  assert.equal(warnings.mock.callCount(), 0, 'no switch to the key');
  assert.deepEqual(log.errors, []);
  assert.ok(sockets.length >= 2);
  for (const s of sockets) assert.ok(!s.url.includes('KEY'), 'the key is in no address');
  assert.ok(new URL(sockets.at(-1).url).searchParams.get('access_token'));
  tr.stop();
});
