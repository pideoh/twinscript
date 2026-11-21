// Captures microphone and/or system (tab / screen share) audio and delivers
// base64 16 kHz PCM chunks. In the macOS desktop app, system audio comes from a native helper
// through window.nativeSystemAudio (app/preload.js) instead of a screen share.

export const canCaptureSystemAudio = () =>
  !!navigator.mediaDevices?.getDisplayMedia && !/iPhone|iPad|Android/i.test(navigator.userAgent);

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const NATIVE_RATE = 48000; // what the native helper delivers
const PERMISSION_MESSAGE = 'PC音声を取り込む許可がありません。システム設定 → プライバシーとセキュリティ →「画面収録とシステムオーディオ録音」で Twinscript を許可し、アプリを開き直してください。';
const NATIVE_ERROR_MESSAGE = 'PC音声を取り込めませんでした。';

// Whole Float32 samples from an ArrayBuffer or a typed array, copied so they can be transferred.
function toFloat32(data) {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return new Float32Array(bytes.slice(0, bytes.byteLength - (bytes.byteLength % 4)).buffer);
}

export class AudioCapture {
  constructor({ onChunk, onLevel, onEnded }) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.onEnded = onEnded;
    this.streams = [];
    this.gains = [];
    this.systemStream = this.systemProbe = null;
  }

  // source: 'mic' | 'system' | 'both'
  async start(source) {
    const native = source !== 'mic' ? window.nativeSystemAudio ?? null : null;
    try {
      if (source !== 'mic' && !native) {
        // Ask for this first: the picker needs the click's user activation.
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: 'include',
        });
        this.streams.push(display);
        this.systemStream = display;
        if (!display.getAudioTracks().length) {
          throw new Error('共有した画面/タブに音声が含まれていません。共有ダイアログで「音声も共有」をオンにしてください。');
        }
        display.getVideoTracks().forEach((t) => { t.enabled = false; });
        display.getAudioTracks()[0].addEventListener('ended', () => this.onEnded?.());
      }
      if (source !== 'system') {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        this.streams.push(mic);
        mic.getAudioTracks()[0].addEventListener('ended', () => this.onEnded?.());
      }

      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = native
        ? new Ctx({ latencyHint: 'interactive', sampleRate: NATIVE_RATE })
        : new Ctx({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.ctx, 'pcm-processor', { numberOfOutputs: 1 });
      this.node.port.onmessage = (e) => {
        this.onLevel?.(e.data.rms);
        this.onChunk(toBase64(e.data.pcm));
      };
      // Everything that is transcribed is also mixed into `this.stream` for recording.
      const mix = this.ctx.createMediaStreamDestination();
      this.stream = mix.stream;
      for (const stream of this.streams) {
        const source = this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const heard = stream === this.systemStream ? this.#levelled(source) : source;
        heard.connect(this.node);
        heard.connect(mix);
        if (stream === this.systemStream) {
          this.systemProbe = this.ctx.createAnalyser();
          this.systemProbe.fftSize = 2048;
          source.connect(this.systemProbe);
        }
      }
      if (native) await this.startNative(native, mix);
      // Keep the graph pulling without playing anything back.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.ctx.destination);
      if (this.ctx.state !== 'running') await this.ctx.resume();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  // Plays the helper's samples through a worklet connected where a screen share would be.
  async startNative(native, mix) {
    const feeder = new AudioWorkletNode(this.ctx, 'pcm-feeder', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    });
    this.feeder = feeder;
    const heard = this.#levelled(feeder);
    heard.connect(this.node);
    heard.connect(mix);
    this.systemProbe = this.ctx.createAnalyser();
    this.systemProbe.fftSize = 2048;
    feeder.connect(this.systemProbe);
    this.native = native;
    native.onData((data) => {
      if (this.feeder !== feeder) return;
      const samples = toFloat32(data);
      feeder.port.postMessage(samples, [samples.buffer]);
    });
    native.onEnd((reason) => {
      if (this.native !== native) return;
      this.stop();
      this.onEnded?.(new Error(reason === 'permission' ? PERMISSION_MESSAGE : NATIVE_ERROR_MESSAGE));
    });
    try {
      await native.start();
    } catch {
      throw new Error(NATIVE_ERROR_MESSAGE);
    }
  }

  // PC audio can be very quiet (it follows the playing app's own volume), so its level is evened
  // out before it is transcribed and recorded. The probe keeps measuring the raw signal.
  #levelled(source) {
    const gain = new AudioWorkletNode(this.ctx, 'auto-gain', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    source.connect(gain);
    this.gains.push(gain);
    return gain;
  }

  // Peak level (0..1) of the system audio right now, or null when it is not being captured.
  // Exactly 0 means no samples are arriving at all, which is how a missing OS permission shows up.
  systemLevel() {
    if (!this.systemProbe) return null;
    const samples = new Float32Array(this.systemProbe.fftSize);
    this.systemProbe.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  stop() {
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.streams = [];
    if (this.native) {
      const native = this.native;
      this.native = null;
      native.onData(null);
      native.onEnd(null);
      native.stop()?.catch?.(() => {});
    }
    if (this.feeder) { this.feeder.disconnect(); this.feeder = null; }
    this.gains.forEach((g) => g.disconnect());
    this.gains = [];
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}
