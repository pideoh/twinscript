// Reads finished translations aloud with the system's speech synthesis (Web Speech API: no
// network, no key). DOM-free; the synthesizer is injected so it can be tested.

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

export class ReadAloud {
  // maxWaiting: sentences kept in line behind the one being read. When another one arrives the
  // oldest waiting one is dropped, so the voice never falls far behind the meeting.
  constructor({
    synth = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    maxWaiting = 2,
  } = {}) {
    this.synth = synth;
    this.Utterance = Utterance;
    this.maxWaiting = maxWaiting;
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
    this.waiting.push({ text: s, lang: speechLang(code) });
    while (this.waiting.length > this.maxWaiting) this.waiting.shift();
    this.#next();
  }

  stop() {
    this.waiting = [];
    this.current = null;
    if (this.available) this.synth.cancel();
  }

  #next() {
    if (this.current || !this.waiting.length) return;
    const { text, lang } = this.waiting.shift();
    const u = new this.Utterance(text);
    u.lang = lang;
    const voice = pickVoice(this.synth.getVoices?.() ?? [], lang);
    if (voice) u.voice = voice;
    const done = () => {
      if (this.current !== u) return; // stopped meanwhile
      this.current = null;
      this.#next();
    };
    u.onend = done;
    u.onerror = done;
    this.current = u;
    this.synth.speak(u);
  }
}
