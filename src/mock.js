// Demo engines used with ?mock=1 — lets the UI run without an API key or microphone.

const SCRIPT = [
  ['それでは本日の定例会議を始めます。', "Let's begin today's regular meeting."],
  ['まず先週の進捗について共有をお願いします。', "First, please share last week's progress."],
  ['Sure. We finished the API integration and started load testing on Friday.', 'はい。API連携が完了し、金曜日から負荷テストを始めました。'],
  ['負荷テストの結果はいつ頃出そうですか？', 'When do you expect the load test results?'],
  ['We should have the full report by Wednesday.', '水曜日までには完全なレポートをお出しできる見込みです。'],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockTranscriber {
  constructor({ onInterim, onFinal, onState }) {
    Object.assign(this, { onInterim, onFinal, onState });
  }
  async start() {
    this.running = true;
    this.onState('listening');
    for (let i = 0; this.running; i = (i + 1) % SCRIPT.length) {
      const text = SCRIPT[i][0];
      const step = Math.max(2, Math.ceil(text.length / 8));
      for (let n = step; n < text.length && this.running; n += step) {
        this.onInterim(text.slice(0, n));
        await sleep(180);
      }
      if (!this.running) return;
      this.onFinal(text);
      await sleep(900);
    }
  }
  stop() { this.running = false; }
  sendAudio() {}
}

export class MockTranslator {
  async translate(text, { onDelta } = {}) {
    const hit = SCRIPT.find(([src]) => src === text);
    const full = hit ? hit[1] : `… ${text.length} chars`;
    for (let n = 6; n < full.length; n += 6) {
      await sleep(40);
      onDelta?.(full.slice(0, n));
    }
    onDelta?.(full);
    return full;
  }
}
