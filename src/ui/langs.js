// The spoken languages the app offers, how they are named and tagged on screen, and how a setting
// that names a place (A / B / C) keeps meaning the same language when the languages change. Pure,
// DOM-free: the display names (Intl.DisplayNames for the UI language) are passed in.

// code: what the recognizer is told; display: the tag whose name is shown in the UI language
// (no region, but the script for Chinese); name: what the translation prompt says.
export const LANGS = [
  { code: 'ja-JP', display: 'ja', name: 'Japanese' },
  { code: 'en-US', display: 'en', name: 'English' },
  { code: 'cmn-Hans-CN', display: 'zh-Hans', name: 'Simplified Chinese' },
  { code: 'cmn-Hant-TW', display: 'zh-Hant', name: 'Traditional Chinese' },
  { code: 'ko-KR', display: 'ko', name: 'Korean' },
  { code: 'es-ES', display: 'es', name: 'Spanish' },
  { code: 'fr-FR', display: 'fr', name: 'French' },
  { code: 'de-DE', display: 'de', name: 'German' },
  { code: 'it-IT', display: 'it', name: 'Italian' },
  { code: 'pt-BR', display: 'pt', name: 'Portuguese' },
  { code: 'vi-VN', display: 'vi', name: 'Vietnamese' },
  { code: 'th-TH', display: 'th', name: 'Thai' },
  { code: 'id-ID', display: 'id', name: 'Indonesian' },
  { code: 'hi-IN', display: 'hi', name: 'Hindi' },
];

// The English name the translation prompt uses, or undefined for a code the app does not offer.
export const langName = (code) => LANGS.find((l) => l.code === code)?.name;

// The language's name in the UI language, from `names` (an Intl.DisplayNames, or null when there is
// none): its English name when the display names cannot tell, the code itself for an unknown one.
export function langLabel(code, names) {
  const l = LANGS.find((x) => x.code === code);
  if (!l) return code;
  try {
    return names?.of(l.display) ?? l.name;
  } catch {
    return l.name;
  }
}

// The short code that leads a translation line: "EN", "JA", "ZH". All tags have the same width,
// so the translations start at the same place. Two selected languages that share the code
// (Simplified and Traditional Chinese) keep their full one. `selected` is the selected languages
// ([A, B, C], empty for none); the code itself among them is ignored.
export function langTag(code, selected) {
  const display = LANGS.find((l) => l.code === code)?.display ?? code;
  const short = (d) => d.split('-')[0];
  const others = selected.filter((c) => c && c !== code);
  const clash = others.some((c) => short(LANGS.find((l) => l.code === c)?.display ?? c) === short(display));
  return (clash ? display : short(display)).toUpperCase();
}

// A choice stored as a place ('A', 'B' or 'C') means the language in that place, so it moves with
// that language when the languages change places: `was` and `now` are { A, B, C } before and after
// ('' for no third language). A choice of the third language when none is left becomes `whenGone`.
// Any other choice ('all', 'off', 'both') is kept.
export function followPlace(choice, was, now, whenGone) {
  const places = ['A', 'B', 'C'];
  const moved =
    places.includes(choice) && was[choice] ? (places.find((p) => now[p] === was[choice]) ?? choice) : choice;
  return moved === 'C' && !now.C ? whenGone : moved;
}

// What the language selects show after one of the first two (`side`, 'A' or 'B') was changed:
// `picked` is { A, B, C } as the selects show them now ('' for no third language) and `stored` the
// languages saved before the change. The two never stay equal: the other one gets the stored
// language of its own side, or else the first language offered that differs. The third language
// never equals the first two: it takes the language the changed one had, or is turned off when that
// is in use too.
export function followLangChange(side, picked, stored) {
  const other = side === 'A' ? 'B' : 'A';
  const now = { ...picked };
  if (now[side] === now[other]) now[other] = side === 'A' ? stored.B : stored.A;
  if (now[side] === now[other]) now[other] = LANGS.find((l) => l.code !== now[side]).code;
  if (now.C && (now.C === now.A || now.C === now.B)) {
    const previous = stored[side];
    now.C = [now.A, now.B, now.C].includes(previous) ? '' : previous;
  }
  return now;
}

// What the language selects show after the third one was changed (arguments as above). A third
// language that equals one of the first two takes its place there; that one gets the third
// language's stored value, or the first language not in use when there was none or it is in use.
export function followThirdLangChange(picked, stored) {
  const now = { ...picked };
  const inUse = () => [now.A, now.B, now.C];
  for (const side of ['A', 'B']) {
    if (!now.C || now[side] !== now.C) continue;
    const previous = stored.C;
    now[side] = previous && !inUse().includes(previous) ? previous : LANGS.find((l) => !inUse().includes(l.code)).code;
  }
  return now;
}
