// Streaming speech-to-text over the Gemini Live API (gemini-3.5-transcribe-live).
// A session lasts at most 10 minutes, so connections are rotated transparently:
// a fresh one is opened in the background and audio is switched over at a pause.
import { MessageError } from './message-error.js';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-3.5-transcribe-live';
const ROTATE_SOFT_MS = 8.5 * 60 * 1000; // rotate at the next pause after this
const ROTATE_HARD_MS = 9.5 * 60 * 1000; // rotate regardless
const READY_FALLBACK_MS = 1500;
const MAX_PENDING_CHUNKS = 150; // ~15 s of audio buffered while (re)connecting
const MAX_RETRIES = 5;
const FATAL_REASON = /api.?key|permission|unauth|credential|quota|billing|not found|not supported/i;

export class GeminiLiveTranscriber {
  constructor({ apiKey, languageCodes, smart, onInterim, onFinal, onState, onError }) {
    this.apiKey = apiKey;
    this.languageCodes = languageCodes;
    this.smart = smart;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onState = onState;
    this.onError = onError;
    this.running = false;
    this.active = null;
    this.pending = [];
    this.retries = 0;
  }

  start() {
    this.running = true;
    this.onState('connecting');
    this.active = this.#open();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    const conn = this.active;
    this.active = null;
    this.pending = [];
    if (conn) this.#retire(conn);
    if (this.next) {
      this.#retire(this.next);
      this.next = null;
    }
  }

  sendAudio(base64) {
    const conn = this.active;
    if (conn?.ready && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } } }));
    } else if (this.running) {
      this.pending.push(base64);
      if (this.pending.length > MAX_PENDING_CHUNKS) this.pending.shift();
    }
  }

  #open() {
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.apiKey)}`);
    ws.binaryType = 'arraybuffer';
    const conn = { ws, ready: false, retired: false, timers: [] };

    ws.onopen = () => {
      const transcription = { languageCodes: this.languageCodes };
      if (this.smart) transcription.mode = 'SMART';
      ws.send(
        JSON.stringify({
          setup: {
            model: MODEL,
            generationConfig: { responseModalities: ['TEXT'] },
            inputAudioTranscription: transcription,
          },
        }),
      );
      // setupComplete normally arrives right away; don't hang if it doesn't.
      conn.timers.push(setTimeout(() => this.#markReady(conn), READY_FALLBACK_MS));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.setupComplete) this.#markReady(conn);
      if (msg.goAway && conn === this.active) this.#rotate();

      const content = msg.serverContent;
      if (!content) return;
      const interim = content.interimInputTranscription?.text;
      if (interim && conn === this.active) this.onInterim(interim);
      const final = content.inputTranscription?.text;
      if (final?.trim()) {
        this.onFinal(final.trim());
        if (conn === this.active && Date.now() > conn.softAt) this.#rotate();
      }
    };

    ws.onclose = (event) => {
      conn.timers.forEach(clearTimeout);
      if (conn.retired || !this.running) return;
      if (conn === this.next) {
        this.next = null;
        return;
      } // background rotation failed; hard timer or drop will retry
      this.#handleDrop(conn, event);
    };
    ws.onerror = () => {}; // onclose follows with details
    return conn;
  }

  #markReady(conn) {
    if (conn.ready || conn.retired || conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ready = true;
    conn.softAt = Date.now() + ROTATE_SOFT_MS;
    conn.timers.push(
      setTimeout(() => {
        if (conn === this.active) this.#rotate();
      }, ROTATE_HARD_MS),
    );

    if (conn === this.next) {
      // Switch audio over to the fresh session, let the old one flush its last result.
      const old = this.active;
      this.active = conn;
      this.next = null;
      if (old) this.#retire(old, 4000);
    }
    if (conn === this.active) {
      this.retries = 0;
      const queued = this.pending;
      this.pending = [];
      for (const chunk of queued) this.sendAudio(chunk);
      this.onState('listening');
    }
  }

  #rotate() {
    if (this.next || !this.running) return;
    this.next = this.#open();
  }

  #retire(conn, delay = 0) {
    conn.retired = true;
    conn.timers.forEach(clearTimeout);
    try {
      if (conn.ws.readyState === WebSocket.OPEN)
        conn.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch {
      /* socket already gone */
    }
    const close = () => {
      try {
        conn.ws.close();
      } catch {
        /* ignore */
      }
    };
    if (delay) setTimeout(close, delay);
    else close();
  }

  #handleDrop(conn, event) {
    const reason = event.reason || '';
    if (this.next) {
      this.#retire(this.next);
      this.next = null;
    }

    if (!conn.ready && FATAL_REASON.test(reason)) {
      return this.#fail(new MessageError('error.connectFailed', { reason }));
    }
    if (!conn.ready && this.languageCodes.length && !this.triedAuto) {
      // The language hint may be unsupported; fall back to automatic detection.
      this.triedAuto = true;
      this.languageCodes = [];
      this.active = this.#open();
      return;
    }
    if (++this.retries > MAX_RETRIES) {
      return this.#fail(
        reason
          ? new MessageError('error.disconnected', { reason })
          : new MessageError('error.disconnectedCode', { code: event.code }),
      );
    }
    this.onState('reconnecting');
    this.active = null;
    this.retryTimer = setTimeout(
      () => {
        if (this.running) this.active = this.#open();
      },
      Math.min(500 * 2 ** (this.retries - 1), 8000),
    );
  }

  #fail(error) {
    this.stop();
    this.onError(error);
  }
}
