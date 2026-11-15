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

  stop() {
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.streams = [];
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}
