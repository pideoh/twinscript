// Demo engines used with ?mock=1 — lets the UI run without an API key or microphone.

import { cleanQuestion } from '../session/ask.js';
import { formatElapsed } from '../session/exporter.js';

const SCRIPT = [
  ['それでは本日の定例会議を始めます。', "Let's begin today's regular meeting."],
  ['まず先週の進捗について共有をお願いします。', "First, please share last week's progress."],
  [
    'Sure. We finished the API integration and started load testing on Friday.',
    'はい。API連携が完了し、金曜日から負荷テストを始めました。',
  ],
  ['負荷テストの結果はいつ頃出そうですか？', 'When do you expect the load test results?'],
  ['We should have the full report by Wednesday.', '水曜日までには完全なレポートをお出しできる見込みです。'],
];
// The same lines in Simplified Chinese, for a demo with a third language.
const CHINESE = [
  '现在开始今天的例会。',
  '首先请分享一下上周的进展。',
  '好的。我们完成了 API 集成，并在周五开始了负载测试。',
  '负载测试的结果大概什么时候能出来？',
  '我们应该能在周三之前拿出完整的报告。',
];
// [Japanese, English, Simplified Chinese] of each line, whichever was spoken.
const LINES = SCRIPT.map(([src, tgt], i) => (/[ぁ-んァ-ン]/.test(src) ? [src, tgt] : [tgt, src]).concat(CHINESE[i]));
const IN = { Japanese: 0, English: 1, 'Simplified Chinese': 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockTranscriber {
  constructor({ onInterim, onFinal, onState }) {
    Object.assign(this, { onInterim, onFinal, onState });
  }
  async start() {
    this.running = true;
    this.onState('listening');
    // One long utterance with no pause: interim text keeps growing, the final only comes at the end.
    const text = SCRIPT.map(([src]) => src).join(' ');
    while (this.running) {
      for (let n = 6; n < text.length && this.running; n += 6) {
        this.onInterim(text.slice(0, n));
        await sleep(150);
      }
      if (!this.running) return;
      this.onFinal(text);
      await sleep(1200);
    }
  }
  stop() {
    this.running = false;
  }
  sendAudio() {}
}

// Made-up but plausible token counts, so the usage screen has something to show in the demo: the
// instructions and context of a request plus about one token per three characters of its text.
const demoUsage = (prompt, answer, overhead) => ({
  promptTokenCount: overhead + Math.ceil(prompt.length / 3),
  candidatesTokenCount: Math.ceil(answer.length / 3),
});

export class MockTranslator {
  // onUsage(usageMetadata, model) is told made-up usage of each request, as if `model` answered it.
  constructor({ model = 'demo', onUsage } = {}) {
    this.model = model;
    this.onUsage = onUsage;
  }
  // into: with a third language, the language asked for (English when the demo has no such lines).
  async translate(text, { onDelta, into } = {}) {
    const hits = into
      ? SCRIPT.flatMap(([src], i) => (text.includes(src) ? [LINES[i][IN[into] ?? 1]] : []))
      : SCRIPT.filter(([src]) => text.includes(src)).map(([, tgt]) => tgt);
    const full = hits.length ? hits.join(' ') : '…';
    for (let n = 6; n < full.length; n += 6) {
      await sleep(40);
      onDelta?.(full.slice(0, n));
    }
    onDelta?.(full);
    this.onUsage?.(demoUsage(text, full, 250), this.model);
    return full;
  }
  // The demo leaves every case the writing system does not settle to 'other'.
  async identify(text = '') {
    this.onUsage?.(demoUsage(text, '{"language":"other"}', 120), this.model);
    return 'other';
  }
}

// Summaries of the demo meeting, one per preset template (custom templates get the quick one),
// whatever the session contains. Streamed in pieces like the real answer.
const DEMO_SUMMARIES = {
  'preset:quick': `## Overview

The weekly meeting reviewed last week's progress. The **API integration is finished** and load testing started on Friday.

## Key points

- The API integration is complete.
- Load testing began on Friday.

## Decisions

- The full load test report will be shared by Wednesday.

## Action items

- Share the full load test report (Engineering team, Wednesday)
- Review the load test results`,
  'preset:executive': `## Conclusion

The API integration is done and the project is on track; load test results arrive by **Wednesday**.

## Background

A regular weekly check on the integration project.

## Main points discussed

- The API integration was completed last week.
- Load testing started on Friday.

## Decisions

- The full load test report will be shared by Wednesday.

## Risks and open questions

- Load test results are still pending.

## Next actions

- Engineering team: share the full report by Wednesday.`,
  'preset:minutes': `## Attendees

Not identifiable from the transcript.

## Discussion

### Last week's progress

The API integration was finished and load testing started on Friday.

### Load test results

The full report is expected by Wednesday.

## Decisions

- Share the full load test report by Wednesday.

## Action items

| Task | Owner | Due date |
| --- | --- | --- |
| Share the full load test report | Engineering team | Wednesday |
| Review the load test results | - | - |

## Open issues

- The load test results are not in yet.

## Next meeting

Not set.`,
  'preset:actions': `- **Engineering team**: share the full load test report (Wednesday)
- Review the load test results`,
  'preset:customer': `## Customer's situation and problems

Not discussed: this was an internal progress meeting.

## Requests and concerns

- When the load test results will be available.

## What was agreed

- The full report will be shared by Wednesday.

## Our follow-ups

- Share the full load test report (Engineering team, Wednesday)

## Next meeting

Not set.`,
  'preset:sales': `## Context

An internal weekly meeting, not a sales call.

## Pain points

Not discussed

## Budget

Not discussed

## Authority

Not discussed

## Need

Not discussed

## Timeline

Load test report by Wednesday.

## Competitors mentioned

None.

## Next steps

- Share the full load test report by Wednesday.`,
  'preset:oneOnOne': `## What went well

- The API integration was finished on time.

## Difficulties

- None raised.

## Feedback

- Not discussed.

## Growth

- Not discussed.

## Action items

- Share the full load test report by Wednesday.`,
  'preset:standup': `## Done

- API integration finished.

## In progress

- Load testing, started on Friday.

## Blockers

None`,
};

// Answers to questions about the demo meeting, whatever the question: where load testing stands,
// citing the lines of the transcript that say so (found by their words, at the times the transcript
// shows), in Japanese for a question written in Japanese, else in English. A transcript without
// those lines gets the answer the real model gives when the meeting does not say.
const DEMO_ANSWERS = {
  en: {
    found: (started, report) =>
      `Load testing started on **Friday**${started}, after the API integration was finished. The full report is expected by **Wednesday**${report}.`,
    none: 'The meeting does not say.',
  },
  ja: {
    found: (started, report) =>
      `API連携の完了後、**金曜日**に負荷テストが始まりました${started}。完全なレポートは**水曜日**までに出る見込みです${report}。`,
    none: '会議の中ではそのことに触れていません。',
  },
};

export class MockAsker {
  constructor({ model = 'demo', onUsage } = {}) {
    this.model = model;
    this.onUsage = onUsage;
  }
  // input: as GeminiAsker.ask (segments, question, onDelta, signal).
  async ask({ segments = [], question, onDelta, signal }) {
    const words = (seg) => `${seg.src ?? ''} ${seg.tgt ?? ''}`;
    const cite = (pattern) => {
      const seg = segments.find((s) => s.src && pattern.test(words(s)));
      return seg ? ` [${formatElapsed(seg.elapsed || 0)}]` : '';
    };
    const started = cite(/load test|負荷テスト/);
    const report = cite(/Wednesday|水曜日/);
    const text = DEMO_ANSWERS[/[ぁ-んァ-ン一-龯]/.test(question) ? 'ja' : 'en'];
    const full = started || report ? text.found(started, report) : text.none;
    for (let n = 12; n < full.length; n += 12) {
      await sleep(40);
      if (signal?.aborted) throw new DOMException('The question was cancelled', 'AbortError');
      onDelta?.(full.slice(0, n));
    }
    onDelta?.(full);
    const transcript = segments.map(words).join('');
    const usage = demoUsage(transcript + question, full, 400);
    this.onUsage?.(usage, this.model);
    return {
      question: cleanQuestion(question),
      answer: full,
      model: this.model,
      createdAt: Date.now(),
      truncated: false,
      usage: null,
    };
  }
}

export class MockSummarizer {
  constructor({ model = 'demo', onUsage } = {}) {
    this.model = model;
    this.onUsage = onUsage;
  }
  async summarize(segments, { template, onDelta } = {}) {
    const full = DEMO_SUMMARIES[template?.id] ?? DEMO_SUMMARIES['preset:quick'];
    for (let n = 40; n < full.length; n += 40) {
      await sleep(30);
      onDelta?.(full.slice(0, n));
    }
    onDelta?.(full);
    const transcript = (segments ?? []).map((seg) => `${seg.src ?? ''}${seg.tgt ?? ''}`).join('');
    this.onUsage?.(demoUsage(transcript, full, 600), this.model);
    return { markdown: full, truncated: false };
  }
}
