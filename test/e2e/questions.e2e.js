// Browser tests: questions about a finished session (the Questions tab): asking, the streamed answer
// with the times it cites as links to the transcript, follow-up questions, what is saved and
// deleted, cancelling, errors, the keyboard, while listening, the demo and the usage dialog.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answered,
  askedQuestion,
  gate,
  listening,
  mockGemini,
  mockQuestions,
  RECORDED_LINES,
  reload,
  saved,
  seedRecordedSession,
  sentTurns,
  setup,
  shownTab,
  showTab,
  storedQuestions,
  translated,
  turns,
} from './helpers.js';

const { openApp } = setup();

const focused = (page) => page.evaluate(() => document.activeElement?.id);
const field = (page) => page.inputValue('#question');

// The seeded session (RECORDED_LINES at 00:00:01, 06, 11 and 16 of 20 seconds) with the Questions tab open.
async function seededQuestions(page, lines) {
  await seedRecordedSession(page, lines && { lines });
  await showTab(page, 'questions');
}
async function ask(page, question) {
  await page.fill('#question', question);
  await page.click('#ask');
}

test('a question is answered from the transcript as it streams in; cited times in it open that line of the transcript', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seededQuestions(page);
  assert.ok(await page.isVisible('#questionsIntro'));
  assert.equal(await page.getAttribute('#question', 'placeholder'), 'この会議について質問');
  assert.ok(await page.isDisabled('#ask'), 'an empty question cannot be asked');
  await page.fill('#question', '   ');
  assert.ok(await page.isDisabled('#ask'), 'nor a blank one');

  const answer = gate();
  const requests = await mockQuestions(page, async () => {
    await answer.held;
    return {
      chunks: [
        '報告書は**金曜日**に送られます [00:00:06]。',
        '\n\n- 予定どおり [00:00:16]\n- 会議にない時刻 [00:09:00]\n- コードの中 `[00:00:01]`',
      ],
    };
  });
  await ask(page, '報告書はいつ送られますか？');
  await page.waitForSelector('#askStop:not([hidden])');
  assert.deepEqual(
    (await turns(page)).map((x) => x.question),
    ['報告書はいつ送られますか？'],
    'the question appears at once',
  );
  assert.equal(await field(page), '', 'and leaves the field');
  assert.ok(await page.isHidden('#ask'), 'another question cannot be asked meanwhile');
  assert.equal(await page.textContent('#questionsStatus'), '回答しています…');
  assert.ok(await page.isHidden('#questionsIntro'));
  answer.open();
  await answered(page, 1);

  const [turn] = await turns(page);
  assert.match(turn.answer, /^報告書は金曜日に送られます \[00:00:06\]。/);
  assert.deepEqual(turn.times, ['00:00:06', '00:00:16'], 'a time not in the transcript, or in code, stays text');
  assert.ok(turn.answer.includes('[00:09:00]'));
  assert.equal(await page.textContent('#questionsList .turn .markdown strong'), '金曜日', 'Markdown is rendered');
  assert.equal(
    await page.getAttribute('#questionsList .time-link >> nth=0', 'aria-label'),
    '文字起こしの 00:00:06 を表示',
  );
  assert.ok((await page.locator('#questionsList .time-link').first().boundingBox()).height >= 32);

  // The request: the transcript with its times, and the question.
  assert.equal(requests.length, 1);
  const parts = requests[0].contents[0].parts.map((p) => p.text);
  assert.match(
    parts[0],
    /^<transcript>\n\[00:00:01\] Shall we start with the budget\?\n {2}=> 予算から始めましょうか。/,
  );
  assert.ok(parts[0].includes('[00:00:06] Yes, I will send the report on Friday.'));
  assert.equal(askedQuestion(requests[0]), '報告書はいつ送られますか？');
  assert.match(requests[0].systemInstruction.parts[0].text, /When it does not contain the answer, say so/);

  // A cited time shows the transcript at that line and marks it.
  await page.click('#questionsList .time-link >> text=00:00:06');
  assert.equal(await shownTab(page), 'transcript');
  const line = page.locator('#log .seg').nth(1);
  assert.equal(await line.locator('.src').textContent(), RECORDED_LINES[1].src);
  assert.ok(await line.evaluate((el) => el.classList.contains('marked')));
  assert.ok(await line.evaluate((el) => el === document.activeElement), 'the line takes the focus');
  const [box, log] = [await line.boundingBox(), await page.locator('#log').boundingBox()];
  assert.ok(box.y >= log.y && box.y + box.height <= log.y + log.height, 'the line is in view');
  await page.waitForFunction(() => !document.querySelector('#log .seg.marked'), null, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await close();
});

test('a follow-up question carries the earlier turn; questions are saved, shown again after a reload and deleted one by one', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seededQuestions(page);
  const answers = ['Friday [00:00:06].', 'On track [00:00:16].'];
  const requests = await mockQuestions(page, () => ({ body: answers.shift() }));
  await ask(page, 'When is the report sent?');
  await answered(page, 1);
  await ask(page, 'And the schedule?');
  await answered(page, 2);
  assert.deepEqual(sentTurns(requests[0]), [], 'the first question has no earlier turns');
  assert.deepEqual(sentTurns(requests[1]), [{ question: 'When is the report sent?', answer: 'Friday [00:00:06].' }]);

  await saved(page);
  const stored = (await storedQuestions(page)).sort((a, b) => a.createdAt - b.createdAt);
  assert.deepEqual(
    stored.map(({ question, answer, model, truncated }) => ({ question, answer, model, truncated })),
    [
      {
        question: 'When is the report sent?',
        answer: 'Friday [00:00:06].',
        model: 'gemini-3.5-flash-lite',
        truncated: false,
      },
      {
        question: 'And the schedule?',
        answer: 'On track [00:00:16].',
        model: 'gemini-3.5-flash-lite',
        truncated: false,
      },
    ],
  );

  await reload(page);
  await showTab(page, 'questions');
  await page.waitForFunction(() => document.querySelectorAll('#questionsList .turn').length === 2);
  assert.deepEqual(
    (await turns(page)).map((x) => [x.question, x.times]),
    [
      ['When is the report sent?', ['00:00:06']],
      ['And the schedule?', ['00:00:16']],
    ],
    'shown again, with their links',
  );

  // Deleting asks first; declined, nothing changes.
  const deleteButtons = page.locator('#questionsList .turn button[aria-label="この質問と回答を削除"]');
  assert.equal(await deleteButtons.count(), 2);
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    d.dismiss();
  });
  await deleteButtons.first().click();
  assert.equal(asked, '質問「When is the report sent?」とその回答を削除しますか？');
  assert.equal((await turns(page)).length, 2);
  page.once('dialog', (d) => d.accept());
  await deleteButtons.first().click();
  assert.deepEqual(
    (await turns(page)).map((x) => x.question),
    ['And the schedule?'],
  );
  assert.equal(await focused(page), 'question', 'the focus goes to the field');
  await saved(page);
  assert.deepEqual(
    (await storedQuestions(page)).map((x) => x.question),
    ['And the schedule?'],
  );
  await reload(page);
  await showTab(page, 'questions');
  await page.waitForFunction(() => document.querySelectorAll('#questionsList .turn').length === 1);
  assert.deepEqual(errors, []);
  await close();
});

test('deleting the session deletes its questions, and an answer still on its way is dropped quietly', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seededQuestions(page);
  const second = gate();
  let count = 0;
  await mockQuestions(page, async () => {
    if (++count === 2) await second.held;
    return { body: 'Friday [00:00:06].' };
  });
  await ask(page, 'When is the report sent?');
  await answered(page, 1);
  await saved(page);
  assert.equal((await storedQuestions(page)).length, 1);

  await ask(page, 'Who sends it?');
  await page.waitForSelector('#askStop:not([hidden])');
  page.once('dialog', (d) => d.accept());
  await page.locator('#sessionList .session').first().locator('.act').last().click();
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 0);
  second.open();
  await page.waitForTimeout(300);
  await saved(page);
  assert.ok(await page.locator('#toast').isHidden(), 'no notice about a session the user removed');
  assert.deepEqual(await storedQuestions(page), []);
  await reload(page);
  assert.deepEqual(await storedQuestions(page), []);
  assert.equal(await page.locator('#sessionList .session').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test('Stop cancels an answer: nothing is saved and the question goes back to the field', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seededQuestions(page);
  const never = gate();
  const requests = await mockQuestions(page, async () => {
    await never.held;
    return { body: 'Too late.' };
  });
  await ask(page, 'What was decided?');
  await page.waitForSelector('#askStop:not([hidden])');
  await page.click('#askStop');
  await page.waitForSelector('#ask:not([hidden])');
  assert.deepEqual(await turns(page), [], 'the cancelled turn is gone');
  assert.equal(await field(page), 'What was decided?');
  assert.equal(await focused(page), 'question');
  assert.ok(await page.isEnabled('#ask'), 'and can be asked again');
  never.open();
  await saved(page);
  assert.deepEqual(await storedQuestions(page), []);
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, []);
  await close();
});

test('an API error and a rate limit are shown at the turn, and the question stays in the field', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seededQuestions(page);
  const answers = [
    { status: 500, body: { error: { message: 'Internal error' } } },
    { status: 429, body: {} },
    { body: '' },
  ];
  await mockQuestions(page, () => answers.shift());

  await ask(page, 'What was decided?');
  await page.waitForFunction(() => document.querySelector('#questionsList .turn-error'));
  let [turn] = await turns(page);
  assert.equal(turn.question, 'What was decided?');
  assert.equal(turn.error, '質問エラー (500): Internal error');
  assert.equal(await field(page), 'What was decided?');
  assert.ok(await page.isHidden('#toast'), 'said at the turn, not as a notice');
  assert.equal(await page.textContent('#questionsStatus'), '質問エラー (500): Internal error');

  await page.click('#ask');
  await page.waitForFunction(() =>
    document.querySelector('#questionsList .turn-error')?.textContent.includes('レート制限'),
  );
  [turn] = await turns(page);
  assert.equal(turn.error, 'APIのレート制限に達しました。1分ほど待ってから再度お試しください。');
  assert.equal((await turns(page)).length, 1, 'the failed turn is replaced, not repeated');
  assert.equal(await field(page), 'What was decided?');

  await page.click('#ask');
  await page.waitForFunction(() =>
    document.querySelector('#questionsList .turn-error')?.textContent.includes('回答が'),
  );
  assert.equal((await turns(page))[0].error, '回答が返ってきませんでした。再度お試しください。');
  await saved(page);
  assert.deepEqual(await storedQuestions(page), []);
  assert.deepEqual(errors, []);
  await close();
});

test('without an API key, asking opens the settings and keeps the question', async () => {
  const { page, errors, close } = await openApp('', {});
  await seededQuestions(page);
  await ask(page, 'What was decided?');
  await page.waitForSelector('#settings[open]');
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'warning');
  await page.click('#settings button[value=ok]');
  assert.equal(await field(page), 'What was decided?');
  assert.deepEqual(await turns(page), []);
  assert.deepEqual(errors, []);
  await close();
});

test('an answer from part of a long meeting carries a note that says so', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const lines = Array.from({ length: 400 }, (_, i) => ({
    elapsed: i * 5000,
    src: `Line ${i}: ${'we talked about the plan in some detail and agreed to look at it again. '.repeat(3)}`,
    tgt: `行 ${i}`,
  }));
  await seededQuestions(page, lines);
  const requests = await mockQuestions(page, () => ({ body: 'It covers part of the meeting [00:00:05].' }));
  await ask(page, 'What was agreed?');
  await answered(page, 1);
  assert.equal((await turns(page))[0].truncated, true);
  assert.equal(
    await page.textContent('#questionsList .turn-truncated'),
    '長い会議のため、この回答は一部のみをもとにしています。',
  );
  assert.match(requests[0].systemInstruction.parts[0].text, /based on only part of the meeting/);
  await saved(page);
  assert.equal((await storedQuestions(page))[0].truncated, true);
  await reload(page);
  await showTab(page, 'questions');
  await page.waitForSelector('#questionsList .turn-truncated');
  assert.deepEqual(errors, []);
  await close();
});

test('the keyboard: Enter asks, Shift+Enter makes a new line and the field grows; the focus returns to the field', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seededQuestions(page);
  const requests = await mockQuestions(page, () => ({ body: 'Friday [00:00:06].' }));
  await page.focus('#question');
  const oneLine = (await page.locator('#question').boundingBox()).height;
  assert.ok(oneLine >= 32, 'the field is at least 32px tall');
  await page.keyboard.type('When is');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('the report sent?');
  assert.equal(await field(page), 'When is\nthe report sent?');
  assert.ok((await page.locator('#question').boundingBox()).height > oneLine, 'the field grows with its text');
  assert.equal(requests.length, 0);
  await page.keyboard.press('Enter');
  await answered(page, 1);
  assert.equal(askedQuestion(requests[0]), 'When is\nthe report sent?');
  assert.equal(await focused(page), 'question', 'the focus is back in the field');
  assert.equal(await field(page), '');
  await page.keyboard.press('Enter');
  assert.equal(requests.length, 1, 'Enter in an empty field asks nothing');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(outline, 'solid', 'the focused field has a visible outline');
  assert.deepEqual(errors, []);
  await close();
});

test('while listening the tab can be opened but nothing can be asked; an empty session says there is no transcript', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await showTab(page, 'questions');
  assert.ok(await page.isVisible('#questionsEmpty'));
  assert.equal(await page.textContent('#questionsEmpty'), '文字起こしがまだありません');
  assert.ok(await page.isHidden('#questions'));
  await showTab(page, 'transcript');

  await mockGemini(page, [[3, 'final', 'Budget review starts now.']]);
  await page.click('#toggle');
  await listening(page);
  await showTab(page, 'questions');
  assert.ok(await page.isVisible('#questions'));
  assert.equal(await page.textContent('#questionsNote'), '質問はセッションの終了後にできます。');
  assert.ok(await page.isDisabled('#question'));
  assert.ok(await page.isDisabled('#ask'));
  await showTab(page, 'transcript');
  await translated(page, 1);
  await page.click('#toggle');
  await showTab(page, 'questions');
  assert.ok(await page.isHidden('#questionsNote'));
  assert.ok(await page.isEnabled('#question'));
  assert.deepEqual(errors, []);
  await close();
});

test('the demo answers questions with times that open the transcript', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  await page.click('#toggle');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('#log .seg:not(.live) .src')].some((el) => el.textContent.includes('Wednesday')),
    null,
    { timeout: 30_000 },
  );
  await page.click('#toggle');
  await showTab(page, 'questions');
  await ask(page, '負荷テストはどうなっていますか？');
  await answered(page, 1);
  const [turn] = await turns(page);
  assert.match(turn.answer, /負荷テスト/);
  assert.ok(turn.times.length >= 1 && turn.times.length <= 2, 'one or two cited times');
  await page.click('#questionsList .time-link >> nth=0');
  assert.equal(await shownTab(page), 'transcript');
  await page.waitForSelector('#log .seg.marked');
  assert.deepEqual(errors, []);
  await close();
});

test('the usage dialog counts questions in a row of their own', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seededQuestions(page);
  await mockQuestions(page, () => ({ chunks: ['Friday ', '[00:00:06].'] }));
  await ask(page, 'When is the report sent?');
  await answered(page, 1);
  await page.click('#openUsage');
  await page.waitForSelector('#usageDialog[open]');
  const rows = await page
    .locator('#usageSession tr')
    .evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  assert.deepEqual(
    rows.map((r) => r[0]),
    ['ライブ文字起こし', '翻訳', '要約', '話者の識別', '質問', '合計'],
  );
  assert.deepEqual(rows[4].slice(0, 5), ['質問', '', '1', '1,000', '200'], 'counted once');
  assert.match(rows[4][5], /^\$0\.\d+$/);
  await page.click('#usageDialog .dialog-footer button');
  assert.deepEqual(errors, []);
  await close();
});
