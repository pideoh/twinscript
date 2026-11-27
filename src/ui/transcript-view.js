// The transcript in the page: one block per segment (time, speaker, source text, translation),
// in the transcript or, while listening, in the caption zone under it, and the code that leads
// each line. The translation flow (src/translation/flow.js) talks to the page only through the
// API returned here, so it never reads the page as state. A line can also be brought into view and
// marked by its index in the session (showLine), for a time cited in an answer to a question.
//
// The DOM of a segment is attached to the segment object itself (`el`, `speakerEl`, `srcEl`,
// `tgtEl`, and `lines`, a Map of target code to line while it has one line per target language):
// other parts reach a line's speaker control as `seg.speakerEl`. With a third language, or two and
// a sentence in neither, a segment shows one line per target language (`seg.tgts`); otherwise a
// single translation. The rules for which code leads a line are the pure functions exported below.

import { formatElapsed } from '../session/exporter.js';
import { hasLabels } from '../session/speaker-labels.js';
import { languageByScript, sourceByScript } from '../translation/script-hint.js';
import { LANGS, langTag as tagAmong } from './langs.js';

const byCode = (code) => LANGS.find((l) => l.code === code);
// How long a line shown from elsewhere (a time cited in an answer) stays marked.
const MARK_MS = 2000;

// The code of the language a segment's single translation is in, told from the writing system of
// the translation or, failing that, of the source (the translation is then in the other language).
// [codeA, codeB]: the session's two languages. Null when the two share a writing system or there is
// no text yet; the space for the code is then kept, so the text stays aligned.
export function singleLineLang(text, srcText, [codeA, codeB]) {
  const a = byCode(codeA);
  const b = byCode(codeB);
  if (!a || !b || !text) return null;
  const other = (name) => (name === a.name ? b.name : name === b.name ? a.name : null);
  const name = languageByScript(text, a.name, b.name) ?? other(languageByScript(srcText, a.name, b.name));
  return name === a.name ? a.code : name === b.name ? b.code : null;
}

// The code of the language a segment was spoken in, shown before its source text: `lang`, the
// language found when it was translated, else what the writing system of the source `text` tells,
// else (two languages, a single translation line) the other one than the `translation`'s. Null for
// a language that is none of the `selected` codes ([A, B, C], '' for none), or when nothing tells.
export function sourceLineLang({ lang, text, translation, selected, multi }) {
  const langs = selected.map(byCode).filter(Boolean);
  const byName = (name) => langs.find((l) => l.name === name);
  let found = lang ? langs.find((l) => l.code === lang) : null;
  if (!found && !lang && text) {
    found = byName(
      sourceByScript(
        text,
        langs.map((l) => l.name),
      ),
    );
    if (!found && langs.length === 2 && !multi) {
      const tgt = languageByScript(translation, langs[0].name, langs[1].name);
      if (tgt) found = langs.find((l) => l.name !== tgt);
    }
  }
  return found?.code ?? null;
}

// Whether a segment's translation lines `tgts` ([{ lang, text }], or none) are already for the
// target `codes`, in that order.
export const sameTargets = (tgts, codes) => !!tgts && tgts.map((x) => x.lang).join() === codes.join();

// Lines appear with their first text, in the order of the targets: the code of the line shown
// already that a new line for `code` goes before, or undefined to put it last.
export function lineBefore(targets, shown, code) {
  const order = (c) => targets.indexOf(c);
  return shown.find((c) => order(c) > order(code));
}

// els: the page's elements (log, anchor, empty, nowList, jump); settings: the app's settings;
// getCurrent(), getRun(): the session on screen and the run in progress (or null); captionKey(name):
// the name of a caption-zone setting for the languages selected; langLabel(code): a language's name
// in the UI language; showSpeaker(seg): fills a line's speaker control; openSpeakerEditor(seg):
// what clicking it does.
export function createTranscriptView({
  els,
  settings,
  getCurrent,
  getRun,
  captionKey,
  langLabel,
  showSpeaker,
  openSpeakerEditor,
}) {
  function nearBottom() {
    return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120;
  }
  // Whether the reader was at the newest line when the transcript was last on screen (its tab can be
  // hidden while lines are added).
  let nearWhenSeen = true;
  function keepBottom(wasNear) {
    if (wasNear) els.log.scrollTop = els.log.scrollHeight;
  }

  // Builds the DOM for a segment (new or loaded from storage) and attaches it to the segment object.
  function mount(seg, isLive = false) {
    const el = document.createElement('div');
    el.className = `seg${isLive ? ' live' : ''}`;
    const timeEl = document.createElement('div');
    timeEl.className = 'time';
    timeEl.textContent = formatElapsed(seg.elapsed);
    // Who said it, once the speakers are labelled; shown only in the transcript (not the caption zone).
    const speakerEl = document.createElement('button');
    speakerEl.type = 'button';
    speakerEl.className = 'speaker';
    speakerEl.onclick = () => openSpeakerEditor(seg);
    const srcEl = document.createElement('div');
    srcEl.className = 'src';
    srcEl.textContent = seg.src;
    const tgtEl = document.createElement('div');
    tgtEl.className = `tgt${isLive ? ' pending' : ''}`;
    el.append(timeEl, speakerEl, srcEl, tgtEl);
    els.empty.hidden = true;
    Object.assign(seg, { el, speakerEl, srcEl, tgtEl });
    showSpeaker(seg);
    if (seg.tgts) {
      showTargets(seg);
      for (const { lang, text } of seg.tgts) if (text) setLine(seg, lang, text);
    } else {
      tgtEl.textContent = seg.tgt;
      tgtEl.dataset.lang = seg.tgt ? singleTag(seg, seg.tgt) : '';
    }
    tagSource(seg); // also for a segment loaded from storage, which does not go through setText
    if (getRun()) {
      els.nowList.append(el);
      trimCaptions();
    } else {
      els.log.insertBefore(el, els.anchor);
    }
    return seg;
  }

  // Moves the oldest sentences out of the caption zone into the transcript.
  function trimCaptions(keep = settings[captionKey('captionItems')]) {
    const wasNear = nearBottom();
    while (els.nowList.children.length > keep) els.log.insertBefore(els.nowList.firstElementChild, els.anchor);
    keepBottom(wasNear);
    updateJump();
  }

  function setText(seg, part, text, cls) {
    const wasNear = nearBottom();
    const node = part === 'src' ? seg.srcEl : seg.tgtEl;
    node.textContent = text;
    if (part === 'tgt') {
      node.className = `tgt${cls ? ` ${cls}` : ''}`;
      node.dataset.lang = cls === 'error' ? '' : singleTag(seg, text);
    }
    tagSource(seg);
    keepBottom(wasNear);
    updateJump();
  }

  // With a third language a segment has one line per target language, each led by a tag. A line
  // appears with its first text, in the order of seg.tgts.
  function showTargets(seg) {
    seg.tgtEl.className = 'tgt multi';
    seg.tgtEl.replaceChildren();
    seg.lines = new Map();
  }
  // Sets the languages a segment is translated into; returns false when they were already those.
  function setTargets(seg, codes) {
    if (seg.lines && sameTargets(seg.tgts, codes)) return false;
    seg.tgts = codes.map((lang) => ({ lang, text: '' }));
    showTargets(seg);
    return true;
  }
  // Back to a single translation line (two languages, after lines for a sentence in neither).
  function clearTargets(seg) {
    if (!seg.tgts) return;
    delete seg.tgts;
    delete seg.lang;
    seg.lines = null;
  }
  // The code for a segment's single translation (singleLineLang), or '' when nothing tells.
  function singleTag(seg, text) {
    const current = getCurrent();
    const code = singleLineLang(text, seg.srcEl.textContent, [
      current?.langA ?? settings.langA,
      current?.langB ?? settings.langB,
    ]);
    return code ? langTag(code) : '';
  }
  // The code of the language a segment was spoken in, before its source text (sourceLineLang).
  function tagSource(seg) {
    const current = getCurrent();
    const code = sourceLineLang({
      lang: seg.lang,
      text: seg.srcEl.textContent,
      translation: seg.tgtEl.textContent,
      selected: [current?.langA ?? settings.langA, current?.langB ?? settings.langB, current?.langC ?? ''],
      multi: !!seg.lines,
    });
    seg.srcEl.dataset.lang = code ? langTag(code) : '';
  }
  // The short code that leads a translation line, told apart among the selected languages (src/ui/langs.js).
  function langTag(code) {
    return tagAmong(code, [settings.langA, settings.langB, settings.langC]);
  }
  function setLine(seg, code, text, cls) {
    const wasNear = nearBottom();
    let line = seg.lines.get(code);
    if (!line) {
      const lang = byCode(code);
      line = document.createElement('div');
      const tag = document.createElement('span');
      tag.className = 'lang-tag';
      tag.textContent = langTag(code);
      if (lang) tag.title = langLabel(code);
      const body = document.createElement('span');
      body.className = 'tgt-text';
      if (lang) body.lang = lang.display;
      line.append(tag, body);
      const next = lineBefore(
        seg.tgts.map((x) => x.lang),
        [...seg.lines.keys()],
        code,
      );
      seg.tgtEl.insertBefore(line, seg.lines.get(next) ?? null);
      seg.lines.set(code, line);
    }
    line.className = `tgt-line${cls ? ` ${cls}` : ''}`;
    line.lastChild.textContent = text;
    keepBottom(wasNear);
    updateJump();
  }

  // Offer a way back to the latest sentence while the user has scrolled up to re-read.
  function updateJump() {
    if (els.log.clientHeight) nearWhenSeen = nearBottom();
    els.jump.hidden = nearBottom();
  }
  els.log.addEventListener('scroll', updateJump, { passive: true });
  els.jump.onclick = () => {
    els.log.scrollTop = els.log.scrollHeight;
  };

  // Brings the line of the session's segment `index` into view and marks it for a moment (`.marked`,
  // faded out by the stylesheet unless the reader prefers reduced motion); it takes the focus, so a
  // screen reader reads it. False when there is no such line on the page.
  let marked = null;
  function showLine(index) {
    const seg = getCurrent()?.segments[index];
    if (!seg?.el?.isConnected) return false;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (marked) clearTimeout(marked.timer);
    marked?.el.classList.remove('marked');
    seg.el.classList.add('marked');
    seg.el.tabIndex = -1;
    seg.el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    seg.el.focus({ preventScroll: true });
    marked = { el: seg.el, timer: setTimeout(() => seg.el.classList.remove('marked'), MARK_MS) };
    return true;
  }

  // Puts all the lines of `sess` on the page in place of those there (a session opened, or its
  // transcript replaced).
  function showAll(sess) {
    for (const node of els.log.querySelectorAll('.seg')) node.remove();
    els.log.classList.toggle('has-speakers', hasLabels(sess));
    for (const seg of sess.segments) mount(seg);
    els.empty.hidden = sess.segments.length > 0;
  }

  return {
    mount,
    showAll,
    // Shows that a line's translation failed: its line for target `code`, or its single translation.
    showError: (seg, code, text) => (code ? setLine(seg, code, text, 'error') : setText(seg, 'tgt', text, 'error')),
    // The transcript is on screen again: at the newest line if the reader was there, else where it was.
    reveal: () => {
      keepBottom(nearWhenSeen);
      updateJump();
    },
    // Takes a segment off the page (the sentence in progress, when it is dropped).
    unmount: (seg) => seg.el.remove(),
    // Puts `seg` just above `other` (a sentence finished above the one in progress).
    placeBefore: (seg, other) => other.el.before(seg.el),
    // The sentence is no longer in progress.
    markFinished: (seg) => seg.el.classList.remove('live'),
    // Whether the segment is on the page (false once its session was replaced on screen).
    isMounted: (seg) => seg.el.isConnected,
    // The translation shown for a segment: its single translation, or the line for `code`.
    shownTranslation: (seg, code) =>
      code === undefined ? seg.tgtEl.textContent : seg.lines.get(code)?.lastChild.textContent,
    showLine,
    setText,
    setTargets,
    clearTargets,
    setLine,
    tagSource,
    trimCaptions,
  };
}
