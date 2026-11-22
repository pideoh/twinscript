// Demo engines used with ?mock=1 — lets the UI run without an API key or microphone.

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

export class MockTranslator {
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
    return full;
  }
  // The demo leaves every case the writing system does not settle to 'other'.
  async identify() {
    return 'other';
  }
}

// A fixed summary of the demo meeting, whatever the session contains.
export class MockSummarizer {
  async summarize() {
    await sleep(800);
    return {
      summary: {
        overview:
          'The weekly meeting reviewed last week’s progress. The API integration is finished and load testing started on Friday.',
        keyPoints: ['The API integration is complete.', 'Load testing began on Friday.'],
        decisions: ['The full load test report will be shared by Wednesday.'],
        actionItems: [
          { task: 'Share the full load test report', owner: 'Engineering team', due: 'Wednesday' },
          { task: 'Review the load test results', owner: null, due: null },
        ],
      },
      truncated: false,
    };
  }
}
