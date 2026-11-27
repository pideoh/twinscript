// The Questions tab: a mock of the question request (the one whose last part is a <question>), and
// readers of the conversation on screen and of the questions saved in IndexedDB.

import { MOCK_USAGE } from './gemini.js';

const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;

// Mocks the question request, leaving translation and summary requests to the other mocks.
// `respond(request)` (may be async) returns one of:
//   { chunks: ['…', '…'] }   a 200 whose answer streams in these pieces; the last carries MOCK_USAGE
//   { body: '…' }            the same with one piece
//   { status, body }         an HTTP error with `body` (an object, sent as JSON)
// Returns the requests seen, in order. A request the page cancelled before the answer is ignored.
export async function mockQuestions(page, respond) {
  const requests = [];
  await page.route(/streamGenerateContent/, async (route) => {
    const request = route.request().postDataJSON();
    if (!request.contents[0].parts.at(-1).text.startsWith('<question>')) return route.fallback();
    requests.push(request);
    const answer = await respond(request);
    const reply = answer.status
      ? { status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) }
      : {
          status: 200,
          contentType: 'text/event-stream',
          body: (answer.chunks ?? [answer.body])
            .map((text, i, all) =>
              sse({
                candidates: [{ content: { parts: [{ text }] } }],
                ...(i === all.length - 1 && { usageMetadata: MOCK_USAGE }),
              }),
            )
            .join(''),
        };
    await route.fulfill(reply).catch(() => {}); // cancelled meanwhile
  });
  return requests;
}

// What a question request asked, and the earlier turns it carried ([{ question, answer }]).
export const askedQuestion = (request) =>
  request.contents[0].parts.at(-1).text.match(/^<question>\n([\s\S]*)\n<\/question>$/)[1];
export const sentTurns = (request) =>
  [
    ...(request.contents[0].parts.find((p) => p.text.startsWith('<conversation>'))?.text ?? '').matchAll(
      /<question>\n([\s\S]*?)\n<\/question>\n<answer>\n([\s\S]*?)\n<\/answer>/g,
    ),
  ].map(([, question, answer]) => ({ question, answer }));

// The turns on screen: { question, answer, error, truncated, times: [the cited times that are controls] }.
export const turns = (page) =>
  page.locator('#questionsList .turn').evaluateAll((items) =>
    items.map((li) => ({
      question: li.querySelector('.turn-question-text').textContent,
      answer: li.querySelector('.markdown').textContent,
      error: li.querySelector('.turn-error')?.textContent ?? '',
      truncated: !!li.querySelector('.turn-truncated'),
      times: [...li.querySelectorAll('.time-link')].map((b) => b.textContent),
    })),
  );

// Waits until `count` turns are on screen and no answer is on its way.
export const answered = (page, count) =>
  page.waitForFunction(
    (n) => document.querySelectorAll('#questionsList .turn').length === n && document.getElementById('askStop').hidden,
    count,
  );

// The questions saved in IndexedDB, as stored.
export const storedQuestions = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const all = open.result.transaction('questions').objectStore('questions').getAll();
          all.onsuccess = () => {
            open.result.close();
            resolve(all.result);
          };
        };
      }),
  );

// A promise the test resolves when it wants (to hold an answer back).
export function gate() {
  let open;
  const held = new Promise((resolve) => {
    open = resolve;
  });
  return { held, open };
}
