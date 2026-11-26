// Reads finished translations aloud with the system's speech synthesis (Web Speech API: no
// network, no key). DOM-free; the synthesizer is injected so it can be tested. It reports when each
// sentence starts and stops being heard (onStart / onEnd, from the synthesizer's own events), so that
// the app can tell its own voice in what it listens to (src/translation/own-voice.js).

import { ownAudioRestricted } from '../speech/audio.js';

// The app's language codes where the voices are tagged differently.
const BCP47 = { 'cmn-Hans-CN': 'zh-CN', 'cmn-Hant-TW': 'zh-TW' };
export const speechLang = (code) => BCP47[code] ?? code;

const norm = (tag) =>
  String(tag ?? '')
    .replace(/_/g, '-')
    .toLowerCase();

// A voice for the language: one tagged exactly with it, else one of the same primary language.
export function pickVoice(voices, lang) {
  const want = norm(lang);
  const primary = want.split('-')[0];
  return (
    voices.find((v) => norm(v.lang) === want) ?? voices.find((v) => norm(v.lang).split('-')[0] === primary) ?? null
  );
}

// The languages whose translations are read aloud, for the setting ('off', 'A', 'B', 'C' or 'both')
// and the selected languages ([A, B] or [A, B, C]). 'C' needs a third language; 'both' is for two
// languages only, since with three a sentence has two translations. Anything else reads nothing.
export function readAloudLanguages(choice, langs) {
  if (choice === 'both') return langs.length === 2 ? [...langs] : [];
  const i = ['A', 'B', 'C'].indexOf(choice);
  return i >= 0 && langs[i] ? [langs[i]] : [];
}

// Whether translations read aloud would be captured again, and so transcribed and translated in a
// loop: in the desktop app, while PC audio ('system' or 'both') is captured with the app's own sound
// (see ownAudioRestricted). platform: { desktop, platform } as appPlatform() gives it; source: what is
// being captured (the source setting, which cannot change while listening).
export const readAloudHeard = (platform, source) =>
  platform.desktop && !ownAudioRestricted(platform) && (source === 'system' || source === 'both');

// The reading-aloud choice in effect: the stored one, or 'off' while it would be heard again. The
// stored choice is kept and applies again when the source is the microphone only.
export const readAloudInEffect = (choice, platform, source) => (readAloudHeard(platform, source) ? 'off' : choice);

export class ReadAloud {
  // maxWaiting: sentences kept in line behind the one being read. When another one arrives the
  // oldest waiting one is dropped, so the voice never falls far behind the meeting.
  // onStart(text, code): a sentence starts being heard; onEnd(text): it stops, read to the end, failed
  // or cancelled by stop(). Every start is followed by one end; a sentence that never started (dropped
  // while waiting, or failed before the synthesizer started it) reports neither.
  constructor({
    synth = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    maxWaiting = 2,
    onStart = () => {},
    onEnd = () => {},
  } = {}) {
    this.synth = synth;
    this.Utterance = Utterance;
    this.maxWaiting = maxWaiting;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.waiting = [];
    this.current = null;
  }

  get available() {
    return !!(this.synth && this.Utterance);
  }

  // code: one of the app's language codes (or any BCP 47 tag).
  speak(text, code) {
    const s = String(text ?? '').trim();
    if (!this.available || !s) return;
    this.waiting.push({ text: s, code, lang: speechLang(code) });
    while (this.waiting.length > this.maxWaiting) this.waiting.shift();
    this.#next();
  }

  stop() {
    const u = this.current;
    this.waiting = [];
    this.current = null;
    if (u?.started) this.onEnd(u.text);
    if (this.available) this.synth.cancel();
  }

  #next() {
    if (this.current || !this.waiting.length) return;
    const { text, code, lang } = this.waiting.shift();
    const u = new this.Utterance(text);
    u.lang = lang;
    const voice = pickVoice(this.synth.getVoices?.() ?? [], lang);
    if (voice) u.voice = voice;
    u.onstart = () => {
      if (this.current !== u || u.started) return;
      u.started = true;
      this.onStart(text, code);
    };
    const done = () => {
      if (this.current !== u) return; // stopped meanwhile
      this.current = null;
      if (u.started) this.onEnd(text);
      this.#next();
    };
    u.onend = done;
    u.onerror = done;
    this.current = u;
    this.synth.speak(u);
  }
}
