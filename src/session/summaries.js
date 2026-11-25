// A session's summaries as the summary panel lists and shows them: the list (with the one summary
// an earlier version kept, converted), which one is on screen, whether it is out of date, the
// languages a summary can be written in, and the lines sent to be summarized. Making a summary is
// src/session/summarizer.js. Pure, DOM-free.
//
// Every summary made is kept with its session in `summaries`, oldest first. A session saved by an
// earlier version may have `summary`, its one summary in another shape; it is listed first, and
// stays on disk as it was until it is deleted.

import { hasLabels } from './speaker-labels.js';
import { legacySummaryToMarkdown } from './summarizer.js';
import { DEFAULT_TEMPLATE, LENGTHS } from './summary-templates.js';

// A session with at least one finished line (with text) can be summarized.
export const hasFinished = (sess) => sess.segments.some((seg) => seg.src);

// A summary's length as it is used: one of LENGTHS, 'standard' for anything else.
export const lengthOrStandard = (length) => (LENGTHS.includes(length) ? length : 'standard');

// The summary an earlier version kept (`sum`), as an entry of the list. Its Markdown is made now,
// with `labels` (headings and field names in the display language: overview, keyPoints, decisions,
// actionItems, owner, due); templateName: the name shown for the default template.
export function legacySummary(sum, { labels, templateName }) {
  return {
    id: 'legacy',
    legacy: true,
    templateId: DEFAULT_TEMPLATE,
    templateName,
    length: 'standard',
    language: null,
    createdAt: sum.generatedAt ?? 0,
    markdown: legacySummaryToMarkdown(sum, labels),
    model: sum.model ?? '',
    truncated: !!sum.truncated,
    segmentCount: sum.segmentCount ?? 0,
  };
}

// The session's summaries, oldest first; toEntry(sum) converts the one an earlier version kept.
export function summariesOf(sess, toEntry) {
  const old = sess.summary && typeof sess.summary === 'object' ? [toEntry(sess.summary)] : [];
  return [...old, ...(sess.summaries ?? [])];
}

// The summary on screen: the one with the id the user chose, else the latest; null for none.
export const shownSummary = (list, chosenId) => list.find((s) => s.id === chosenId) ?? list.at(-1) ?? null;

// Whether the summary shown is out of date: speech was added after it, or the speakers were
// labelled after it. `speakersOnly`: only the labels are newer, not the speech.
export function staleness(sess, shown) {
  const relabeled = !!shown && hasLabels(sess) && sess.speakerLabels.madeAt > shown.createdAt;
  return {
    stale: !(!shown || (sess.segments.length <= shown.segmentCount && !relabeled)),
    speakersOnly: relabeled && sess.segments.length <= (shown?.segmentCount ?? 0),
  };
}

// The languages a summary can be written in: the session's, then the display language
// (displayCode, or undefined), each once and only those in `offered` (codes).
export function summaryLanguages(sess, displayCode, offered) {
  const codes = [sess.langA, sess.langB, sess.langC, displayCode].filter((c) => offered.includes(c));
  return [...new Set(codes)];
}

// The language chosen in the select: the one saved when it is offered, else the display language,
// else the first one.
export const chosenLanguage = (codes, saved, displayCode) =>
  codes.includes(saved) ? saved : (displayCode ?? codes[0]);

// The lines sent to be summarized; with speaker labels each carries its speaker's name.
// nameOf(id): a speaker's name, or '' for none.
export const summaryLines = (segments, nameOf) =>
  segments.map(({ elapsed, src, tgt, speaker }) => ({
    elapsed,
    src,
    tgt,
    ...(nameOf(speaker) && { speaker: nameOf(speaker) }),
  }));
