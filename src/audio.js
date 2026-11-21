// Captures microphone and/or system (tab / screen share) audio and delivers
// base64 16 kHz PCM chunks.

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

export class AudioCapture {
  constructor({ onChunk, onLevel, onEnded }) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.onEnded = onEnded;
    this.streams = [];
    this.systemStream = this.systemProbe = null;
  }

  // source: 'mic' | 'system' | 'both'
  async start(source) {
    try {
      if (source !== 'mic') {
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
      this.ctx = new Ctx({ latencyHint: 'interactive' });
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
        source.connect(this.node);
        source.connect(mix);
        if (stream === this.systemStream) {
          this.systemProbe = this.ctx.createAnalyser();
          this.systemProbe.fftSize = 2048;
          source.connect(this.systemProbe);
        }
      }
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
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}
