import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRecord, Recorder } from '../../../../src/speech/recorder.js';
import { withGlobals } from '../../../support/globals.js';

// A MediaRecorder that records what it was asked and delivers data or stops on request.
function fakeMediaRecorder({ supported = [], reportedMime = '' } = {}) {
  const made = [];
  class FakeMediaRecorder {
    static isTypeSupported(type) {
      return supported.includes(type);
    }
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.mimeType = reportedMime;
      this.state = 'inactive';
      this.startedWith = undefined;
      made.push(this);
    }
    start(timeslice) {
      this.state = 'recording';
      this.startedWith = timeslice;
    }
    // Like the browser: the last chunk arrives first, then the stop event.
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: { size: 3, tail: true } });
      this.onstop?.();
    }
  }
  return { FakeMediaRecorder, made };
}

test('recording is offered only where the browser can record', async () => {
  assert.equal(canRecord(), false, 'no MediaRecorder here');
  await withGlobals({ MediaRecorder: class {} }, () => assert.equal(canRecord(), true));
  assert.equal(canRecord(), false, 'the stand-in is removed after the test');
});

test('the recording uses the first format the browser supports, at a low bit rate', async () => {
  const { FakeMediaRecorder, made } = fakeMediaRecorder({ supported: ['audio/webm', 'audio/mp4'] });
  await withGlobals({ MediaRecorder: FakeMediaRecorder }, () => {
    const stream = {};
    const rec = new Recorder(stream, () => {});
    assert.equal(made[0].stream, stream);
    assert.deepEqual(made[0].options, { mimeType: 'audio/webm', audioBitsPerSecond: 32000 });
    assert.equal(rec.mime, 'audio/webm');
  });
});

test('the format the browser reports is the one the recording is labelled with', async () => {
  const { FakeMediaRecorder } = fakeMediaRecorder({
    supported: ['audio/webm;codecs=opus'],
    reportedMime: 'audio/webm;codecs=opus',
  });
  await withGlobals({ MediaRecorder: FakeMediaRecorder }, () => {
    assert.equal(new Recorder({}, () => {}).mime, 'audio/webm;codecs=opus');
  });
});

test('when no listed format is supported the browser picks one and the label falls back to webm', async () => {
  const { FakeMediaRecorder, made } = fakeMediaRecorder({ supported: [] });
  await withGlobals({ MediaRecorder: FakeMediaRecorder }, () => {
    const rec = new Recorder({}, () => {});
    assert.deepEqual(made[0].options, { audioBitsPerSecond: 32000 }, 'no mimeType is forced');
    assert.equal(rec.mime, 'audio/webm');
  });
});

test('chunks are handed over every five seconds while recording, and empty ones are dropped', async () => {
  const { FakeMediaRecorder, made } = fakeMediaRecorder();
  await withGlobals({ MediaRecorder: FakeMediaRecorder }, () => {
    const chunks = [];
    const rec = new Recorder({}, (blob) => chunks.push(blob));
    rec.start();
    assert.equal(made[0].startedWith, 5000);
    made[0].ondataavailable({ data: { size: 10, id: 'a' } });
    made[0].ondataavailable({ data: { size: 0, id: 'empty' } });
    made[0].ondataavailable({ data: { size: 4, id: 'b' } });
    assert.deepEqual(
      chunks.map((c) => c.id),
      ['a', 'b'],
    );
  });
});

test('stopping waits for the last chunk and then resolves', async () => {
  const { FakeMediaRecorder, made } = fakeMediaRecorder();
  await withGlobals({ MediaRecorder: FakeMediaRecorder }, async () => {
    const chunks = [];
    const rec = new Recorder({}, (blob) => chunks.push(blob));
    rec.start();
    await rec.stop();
    assert.equal(made[0].state, 'inactive');
    assert.deepEqual(chunks, [{ size: 3, tail: true }], 'the tail was delivered before stop resolved');
  });
});

test('stopping a recording that never started, or already stopped, resolves at once', async () => {
  const { FakeMediaRecorder } = fakeMediaRecorder();
  await withGlobals({ MediaRecorder: FakeMediaRecorder }, async () => {
    const chunks = [];
    const rec = new Recorder({}, (blob) => chunks.push(blob));
    await rec.stop();
    rec.start();
    await rec.stop();
    await rec.stop();
    assert.equal(chunks.length, 1, 'only the first real stop delivered a chunk');
  });
});
