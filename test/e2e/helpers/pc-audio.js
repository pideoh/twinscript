// Stand-in for sharing PC audio (getDisplayMedia); pass it as `openApp`'s `init` script.

// Stands in for sharing PC audio: getDisplayMedia gives a 440 Hz tone at `amplitude`, and the
// constraints the page asked for are kept in window.displayMediaCalls. `desktopApp` ('mac' or
// 'win') makes the page see the desktop app's user agent. `endAfterMs` ends the audio track on its
// own after that long, which is what the macOS app sees without the "System Audio Recording" permission.
export function fakeDisplayMedia({ amplitude = 0.5, endAfterMs, desktopApp } = {}) {
  if (window !== top) return;
  const AGENTS = {
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) twinscript/1.0.0 Chrome/140.0.0.0 Electron/45.4.1 Safari/537.36',
    win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) twinscript/1.0.0 Chrome/140.0.0.0 Electron/45.4.1 Safari/537.36',
  };
  if (desktopApp) Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => AGENTS[desktopApp] });
  window.displayMediaCalls = [];
  navigator.mediaDevices.getDisplayMedia = async (constraints) => {
    window.displayMediaCalls.push(constraints);
    const ctx = new AudioContext();
    const out = ctx.createMediaStreamDestination();
    const tone = ctx.createOscillator();
    const level = ctx.createGain();
    level.gain.value = amplitude;
    tone.connect(level).connect(out);
    tone.start();
    const [track] = out.stream.getAudioTracks();
    if (endAfterMs !== undefined) {
      setTimeout(() => {
        track.stop(); // stopping it here does not fire 'ended', so that is done by hand
        track.dispatchEvent(new Event('ended'));
      }, endAfterMs);
    }
    return new MediaStream([track]);
  };
}
