// Translates finished lines after the fact (a transcript made again from a recording), a few
// requests at a time, with the rules of the live flow (src/translation/flow.js) for what a line is
// translated into and what it is sent with (src/translation/line-targets.js): with two languages one
// request whose direction the translator settles, otherwise one request per target language after
// the line's language is told from its writing system or, failing that, asked of the model.
// DOM-free: the translator, the clock and the signal are passed in.
//
// What is not obvious:
// - The context of a request is the last translated lines before it, as the flow sends them. With
//   several requests at once, an earlier line still being translated is not part of it yet.
// - A request that fails in a way that may pass (`passes` in translator.js: the rate limit, a server
//   error, the network) is tried again after 1.5, 3 and 6 seconds, as in the flow; after that, or for
//   any other failure, the line keeps no translation and its error is returned. Only cancelling stops
//   the whole run.

import { langName } from '../ui/langs.js';
import { perTarget, recentHistory, targetCodes } from './line-targets.js';
import { sourceByScript } from './script-hint.js';
import { passes } from './translator.js';

export const CONCURRENCY = 3; // requests at once
const RETRIES = 3;
const RETRY_MS = 1500;

const aborted = (err, signal) => err?.name === 'AbortError' || !!signal?.aborted;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * Translates `lines` ([{ src, tgt?, tgts?, lang? }], in order) in place: each gets `tgt` and, where it
 * has one line per target language, `lang` (the code it was spoken in, or 'other') and `tgts`
 * ([{ lang, text }], `tgt` being their texts joined by line breaks). langs: [{ code, name }] of the
 * session; otherInto: the setting for speech in none of them; translator: translate(text, { history,
 * into, signal }) and identify(text, names, { signal }) as GeminiTranslator; wait(ms, signal): the
 * pause before a retry; onProgress({ done, total }) after each line. Rejects only when `signal`
 * aborts. Resolves with the failures: [{ index, lang (a target code, or null for a single
 * translation), error }].
 */
export async function translateLines(
  lines,
  { langs, otherInto, translator, signal, concurrency = CONCURRENCY, wait = sleep, onProgress = () => {} },
) {
  const failures = [];
  const total = lines.length;
  let next = 0;
  let done = 0;

  async function request(text, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await translator.translate(text, { ...options, signal });
      } catch (err) {
        if (aborted(err, signal)) throw err;
        if (passes(err) && attempt < RETRIES) {
          await wait(RETRY_MS * 2 ** attempt, signal);
          continue;
        }
        throw err;
      }
    }
  }

  async function translateOne(index) {
    const line = lines[index];
    const earlier = lines.slice(0, index);
    if (!perTarget(langs, line.src, otherInto)) {
      try {
        line.tgt = await request(line.src, { history: recentHistory(earlier) });
      } catch (err) {
        if (aborted(err, signal)) throw err;
        line.tgt = '';
        failures.push({ index, lang: null, error: err });
      }
      return;
    }
    const names = langs.map((l) => l.name);
    const source =
      sourceByScript(line.src, names) ?? (await translator.identify(line.src, names, { signal }).catch(() => 'other'));
    signal?.throwIfAborted();
    line.lang = langs.find((l) => l.name === source)?.code ?? 'other';
    const targets = targetCodes(langs, source, otherInto);
    line.tgts = targets.map((lang) => ({ lang, text: '' }));
    const results = await Promise.allSettled(
      targets.map((code) => request(line.src, { history: recentHistory(earlier, code), into: langName(code) })),
    );
    signal?.throwIfAborted();
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') line.tgts[i].text = result.value;
      else failures.push({ index, lang: targets[i], error: result.reason });
    });
    line.tgt = line.tgts
      .map((x) => x.text)
      .filter(Boolean)
      .join('\n');
  }

  async function worker() {
    while (next < total) {
      signal?.throwIfAborted();
      const index = next++;
      await translateOne(index);
      done++;
      onProgress({ done, total });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  return failures.sort((a, b) => a.index - b.index);
}
