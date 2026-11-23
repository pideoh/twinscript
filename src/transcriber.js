// Streaming speech-to-text over the Gemini Live API (gemini-3.5-transcribe-live).
// A session lasts at most 10 minutes, so connections are rotated transparently:
// a fresh one is opened in the background and audio is switched over at a pause.
// Each connection authenticates with its own single-use token, requested with the API key in a
// header just before connecting, so the key never appears in the connection's address.
import { MessageError } from './message-error.js';

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService';
const TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const TOKEN_TIMEOUT_MS = 10_000;
const MODEL = 'models/gemini-3.5-transcribe-live';
const ROTATE_SOFT_MS = 8.5 * 60 * 1000; // rotate at the next pause after this
const ROTATE_HARD_MS = 9.5 * 60 * 1000; // rotate regardless
const READY_FALLBACK_MS = 1500;
const MAX_PENDING_CHUNKS = 150; // ~15 s of audio buffered while (re)connecting
const MAX_RETRIES = 5;
const FATAL_REASON = /api.?key|permission|unauth|credential|quota|billing|not found|not supported/i;
const KEY_REASON = /api.?key|permission|unauth|credential/i;
const API_KEY_REASON = /api.?key/i;
const TOKEN_REASON = /\btoken\b|expired/i; // a used-up or expired token: get a new one
// Token requests answered like this mean the token service is unavailable, not that the key is wrong.
const NO_TOKEN_SERVICE = new Set([400, 404, 501]);

export class GeminiLiveTranscriber {
  constructor({ apiKey, languageCodes, smart, customVocabulary = [], onInterim, onFinal, onState, onError }) {
    this.apiKey = apiKey;
    this.languageCodes = languageCodes;
    this.smart = smart;
    this.customVocabulary = customVocabulary;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onState = onState;
    this.onError = onError;
    this.running = false;
    this.active = null;
    this.pending = [];
    this.retries = 0;
    this.keyInUrl = false; // set once the token service turns out to be unavailable
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

  // Returns the connection at once; its socket opens once a token has been obtained.
  #open() {
    const conn = { ws: null, ready: false, retired: false, viaToken: false, timers: [] };
    this.#connect(conn);
    return conn;
  }

  async #connect(conn) {
    let url;
    if (!this.keyInUrl) {
      const result = await this.#requestToken();
      if (conn.retired || !this.running) return; // stopped or replaced while waiting
      if (result.token) {
        conn.viaToken = true;
        url = `${WS_BASE}.BidiGenerateContentConstrained?access_token=${encodeURIComponent(result.token)}`;
      } else if (result.unavailable) {
        // The token service is in preview; a meeting must not fail because of it.
        this.keyInUrl = true;
        console.warn(
          `Twinscript: single-use tokens are unavailable (${result.unavailable}); the live connection uses the API key for the rest of this session.`,
        );
      } else {
        return this.#tokenFailed(conn, result);
      }
    }
    url ??= `${WS_BASE}.BidiGenerateContent?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    conn.ws = ws;

    ws.onopen = () => {
      const transcription = { languageCodes: this.languageCodes };
      if (this.smart) transcription.mode = 'SMART';
      if (this.customVocabulary.length) transcription.customVocabulary = this.customVocabulary;
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
      const reason = event.reason || '';
      const tokenTrouble = conn.viaToken && TOKEN_REASON.test(reason) && !API_KEY_REASON.test(reason);
      this.#handleDrop(conn, event, tokenTrouble);
    };
    ws.onerror = () => {}; // onclose follows with details
  }

  // Resolves to { token }, { unavailable: reason } (fall back to the key), { fatal: reason }
  // (the key is refused) or { failed: reason } (worth retrying). Never rejects.
  async #requestToken() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: '{}',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return { failed: 'token request timed out' };
      return { unavailable: this.#redact(`request failed: ${err?.message || err}`) };
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.ok) {
      const name = body?.name;
      return typeof name === 'string' && name ? { token: name } : { unavailable: 'no token in the response' };
    }
    const message = this.#redact(typeof body?.error?.message === 'string' ? body.error.message : '');
    const reason = message || `HTTP ${res.status}`;
    const status = res.status;
    if (status === 401 || status === 403 || (status === 400 && KEY_REASON.test(message))) return { fatal: reason };
    if (NO_TOKEN_SERVICE.has(status)) return { unavailable: `HTTP ${status}${message ? `: ${message}` : ''}` };
    if (FATAL_REASON.test(message)) return { fatal: reason };
    return { failed: reason };
  }

  #redact(text) {
    return this.apiKey ? text.split(this.apiKey).join('***') : text;
  }

  #tokenFailed(conn, { fatal, failed }) {
    if (conn === this.next) {
      this.next = null; // background rotation failed; hard timer or drop will retry
      return;
    }
    if (conn !== this.active) return;
    if (fatal) return this.#fail(new MessageError('error.connectFailed', { reason: fatal }));
    this.#handleDrop(conn, { reason: failed, code: 0 }, true);
  }

  #markReady(conn) {
    if (conn.ready || conn.retired || conn.ws?.readyState !== WebSocket.OPEN) return;
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
    if (!conn.ws) return; // still waiting for its token; it will not connect now
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

  // `transient`: the setup was not the problem (a used-up token, a failed token request), so neither
  // the term list nor the language hint is dropped; it is retried like any dropped connection.
  #handleDrop(conn, event, transient = false) {
    const reason = event.reason || '';
    if (this.next) {
      this.#retire(this.next);
      this.next = null;
    }

    if (!transient && !conn.ready && FATAL_REASON.test(reason)) {
      return this.#fail(new MessageError('error.connectFailed', { reason }));
    }
    if (!transient && !conn.ready && this.customVocabulary.length && !this.triedWithoutVocabulary) {
      // The term list may be rejected; transcribing without it beats not transcribing at all.
      this.triedWithoutVocabulary = true;
      this.customVocabulary = [];
      this.active = this.#open();
      return;
    }
    if (!transient && !conn.ready && this.languageCodes.length && !this.triedAuto) {
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
