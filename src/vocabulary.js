// Custom vocabulary for transcription: terms handed to the recognizer, and correction rules
// applied to the recognized text. Pure functions, no DOM.

export const MAX_TERMS = 1000; // the recognizer accepts up to 1,000 terms
const RULE = '=>';

// One entry per line. `wrong => right` is a correction rule (and `right` also becomes a term);
// any other non-empty line is a term. Terms are de-duplicated and capped at MAX_TERMS.
export function parseVocabulary(text) {
  const terms = [];
  const rules = [];
  const seen = new Set();
  const addTerm = (term) => {
    if (seen.has(term) || terms.length >= MAX_TERMS) return;
    seen.add(term);
    terms.push(term);
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(RULE);
    if (at === -1) {
      addTerm(line);
      continue;
    }
    const from = line.slice(0, at).trim();
    const to = line.slice(at + RULE.length).trim();
    if (!from || !to) continue;
    rules.push({ from, to });
    addTerm(to);
  }
  return { terms, rules };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replaces every occurrence of each rule's `from` (literal, case-insensitive) with its `to`.
// Longer `from` values win where rules overlap; otherwise rules keep their order. All matches are
// found in one pass, so text inserted by one rule is never rewritten by another.
export function applyReplacements(text, rules) {
  if (!text || !rules?.length) return text;
  const ordered = rules
    .map((rule, i) => ({ ...rule, i }))
    .filter((rule) => rule.from)
    .sort((a, b) => b.from.length - a.from.length || a.i - b.i);
  if (!ordered.length) return text;
  const pattern = new RegExp(ordered.map((rule) => `(${escapeRegExp(rule.from)})`).join('|'), 'giu');
  return text.replace(pattern, (...match) => {
    const groups = match.slice(1, ordered.length + 1);
    return ordered[groups.findIndex((g) => g !== undefined)].to;
  });
}
