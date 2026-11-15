// Records the captured audio so it can be saved alongside the transcript.

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export const canRecord = () => typeof MediaRecorder !== 'undefined';

export class Recorder {
  // onChunk(blob) is called every few seconds so a reload or crash loses very little.
  constructor(stream, onChunk) {
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32000 });
    this.mime = this.rec.mimeType || mimeType || 'audio/webm';
    this.rec.ondataavailable = (e) => { if (e.data.size) onChunk(e.data); };
  }

  start() { this.rec.start(5000); }

  // Resolves once the last chunk has been delivered.
  stop() {
    return new Promise((resolve) => {
      if (this.rec.state === 'inactive') return resolve();
      this.rec.onstop = resolve;
      this.rec.stop();
    });
  }
}
