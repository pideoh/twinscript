// Captures microphone and/or system (tab / screen share) audio and delivers
// base64 16 kHz PCM chunks. In the desktop app, system audio comes from the same getDisplayMedia
// call, answered by the main process without a picker (app/main.js).
import { MessageError } from '../ui/message-error.js';

export const canCaptureSystemAudio = () => !!navigator.mediaDevices?.getDisplayMedia;

const inDesktopApp = () => /\bElectron\//.test(navigator.userAgent);

// The macOS desktop app, where PC audio depends on the "System Audio Recording" permission.
export const inMacDesktopApp = () => inDesktopApp() && /Mac/.test(navigator.userAgent);

// Where the page runs: { desktop, platform }, platform being 'mac', 'windows' or 'other'.
export const appPlatform = (ua = navigator.userAgent) => ({
  desktop: /\bElectron\//.test(ua),
  platform: /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'mac' : 'other',
});

// Whether PC audio is asked for without the app's own sound (restrictOwnAudio). Only the desktop app
// captures the whole system's audio, which includes its own sound. On Windows the option switches
// Chromium from the loopback of the output device to a per-process capture, which misses the sound of
// some apps (the Teams desktop app), so Windows takes the plain loopback, the app's own sound included.
export const ownAudioRestricted = ({ desktop, platform }) => desktop && platform !== 'windows';

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class AudioCapture {
  constructor({ onChunk, onLevel, onEnded, onFileEnded }) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.onEnded = onEnded;
    this.onFileEnded = onFileEnded;
    this.streams = [];
    this.gains = [];
    this.systemStream = this.systemProbe = null;
  }

  // source: 'mic' | 'system' | 'both', or 'file' (debug only) with the File to play.
  async start(source, file) {
    try {
      if (source === 'system' || source === 'both') {
        const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (ownAudioRestricted(appPlatform())) audio.restrictOwnAudio = true;
        // Ask for this first: the picker needs the click's user activation.
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio, systemAudio: 'include' });
        this.streams.push(display);
        this.systemStream = display;
        if (!display.getAudioTracks().length) {
          throw new MessageError('error.noSharedAudio');
        }
        display.getVideoTracks().forEach((t) => {
          t.enabled = false;
        });
        // In the macOS app a missing "System Audio Recording" permission raises no error; the
        // audio track just ends, so that is when the user is told how to allow it.
        const why = inMacDesktopApp() ? new MessageError('error.systemAudioPermission') : undefined;
        display.getAudioTracks()[0].addEventListener('ended', () => this.onEnded?.(why));
      }
      if (source === 'mic' || source === 'both') {
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
        const heard = stream === this.systemStream ? this.#levelled(source) : source;
        heard.connect(this.node);
        heard.connect(mix);
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
      if (source === 'file') await this.#playFile(file, mix);
      if (this.ctx.state !== 'running') await this.ctx.resume();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  // Debug only: plays a decoded audio file in real time into the same chain the microphone feeds,
  // without sending it to the speakers. Silence keeps flowing afterwards, so the recognizer hears
  // the end of the last utterance; onFileEnded says when the file itself is over.
  async #playFile(file, mix) {
    let buffer;
    try {
      buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new MessageError('error.audioFileDecode', { name: file.name });
    }
    const silence = this.ctx.createConstantSource();
    silence.offset.value = 0;
    silence.connect(this.node);
    silence.start();
    const player = this.ctx.createBufferSource();
    player.buffer = buffer;
    player.connect(this.node);
    player.connect(mix);
    player.onended = () => this.onFileEnded?.();
    player.start();
    this.players = [silence, player];
  }

  // PC audio can be very quiet (it follows the playing app's own volume), so its level is evened
  // out before it is transcribed and recorded. The probe keeps measuring the raw signal.
  #levelled(source) {
    const gain = new AudioWorkletNode(this.ctx, 'auto-gain', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
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
    for (const s of this.streams) for (const track of s.getTracks()) track.stop();
    this.streams = [];
    for (const player of this.players ?? []) {
      player.onended = null;
      player.disconnect();
    }
    this.players = [];
    for (const gain of this.gains) gain.disconnect();
    this.gains = [];
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
