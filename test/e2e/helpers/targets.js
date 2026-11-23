// Translation mock and readers for tests with a third language, or a sentence in neither language.

// Used with a third language, or with two and a sentence in neither of them.
// Translation requests that name their target answer "[Target] text"; a request that asks which
// language a sentence is in answers with `identified`. Returns the identify requests seen.
export async function mockTargets(page, identified = 'Japanese') {
  const identify = [];
  await page.route(/streamGenerateContent/, (route) => {
    const request = route.request().postDataJSON();
    const text = request.contents[0].parts[0].text.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    let answer;
    if (request.generationConfig.responseJsonSchema) {
      identify.push({ text, request });
      answer = JSON.stringify({ language: identified });
    } else {
      const into = request.systemInstruction.parts[0].text.match(/Translate it into ([^.]+)\./)?.[1] ?? '?';
      answer = `[${into}] ${text}`;
    }
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return identify;
}

// Each finished row: its source and its translation lines as [tag, text].
export const tagged = (page) =>
  page.locator('.seg:not(.live)').evaluateAll((nodes) =>
    nodes.map((n) => ({
      src: n.querySelector('.src').textContent,
      lines: [...n.querySelectorAll('.tgt-line')].map((l) => [
        l.querySelector('.lang-tag').textContent,
        l.querySelector('.tgt-text').textContent,
      ]),
    })),
  );
// Waits until `count` rows have `lines` translation lines each (a list, one count per row).
export const linesDone = (page, counts) =>
  page.waitForFunction((want) => {
    const segs = [...document.querySelectorAll('.seg:not(.live)')];
    return (
      segs.length === want.length &&
      segs.every(
        (s, i) =>
          [...s.querySelectorAll('.tgt-line:not(.pending) .tgt-text')].filter((t) => t.textContent.startsWith('['))
            .length === want[i],
      )
    );
  }, counts);
