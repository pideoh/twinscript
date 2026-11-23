// Mocks of the Gemini endpoints used by almost every browser test: the live transcription
// (WebSocket), its single-use token request and the streaming translation.

export const TOKEN_ENDPOINT = /generativelanguage\.googleapis\.com\/v1beta\/auth_tokens/;
let tokensIssued = 0;
export const grantToken = (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ name: `auth_tokens/e2e-${++tokensIssued}` }),
  });

// What every mocked translation reports as used, in the last (here the only) chunk of its answer.
export const MOCK_USAGE = { promptTokenCount: 1000, candidatesTokenCount: 150, thoughtsTokenCount: 50 };

// Mocks the Gemini endpoints: the live transcription (WebSocket), its token request and translation.
// `script` is a list of [audioChunkNumber, 'interim' | 'final', text]. `tokens` is how the token
// request is answered: 'grant', 'unreachable' (a network failure) or an HTTP status with
// `tokenError` as the error message. Returns the token requests and the WebSocket addresses seen.
// Each translation answers with MOCK_USAGE as its usageMetadata.
export async function mockGemini(page, script, { tokens = 'grant', tokenError = '' } = {}) {
  let chunks = 0;
  const tokenRequests = [];
  const sockets = [];
  await page.route(TOKEN_ENDPOINT, (route) => {
    const request = route.request();
    tokenRequests.push({ url: request.url(), headers: request.headers(), body: request.postData() });
    if (tokens === 'grant') return grantToken(route);
    if (tokens === 'unreachable') return route.abort('failed');
    return route.fulfill({
      status: tokens,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: tokens, message: tokenError } }),
    });
  });
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    sockets.push(ws.url());
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (!msg.realtimeInput?.audio) return;
      chunks++;
      for (const [at, kind, text] of script) {
        const field = kind === 'final' ? 'inputTranscription' : 'interimInputTranscription';
        if (at === chunks) ws.send(JSON.stringify({ serverContent: { [field]: { text } } }));
      }
    });
  });
  await page.route(/streamGenerateContent/, (route) => {
    const prompt = route.request().postDataJSON().contents[0].parts[0].text;
    const text = prompt.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    const chunk = { candidates: [{ content: { parts: [{ text: `訳:${text}` }] } }], usageMetadata: MOCK_USAGE };
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(chunk)}\n\n` });
  });
  return {
    restart: () => {
      chunks = 0;
    },
    tokenRequests,
    sockets,
  };
}
export const translated = (page, count) =>
  page.waitForFunction(
    (n) =>
      document.querySelectorAll('.seg:not(.live)').length === n &&
      [...document.querySelectorAll('.seg:not(.live) .tgt')].every((el) => el.textContent.startsWith('訳:')),
    count,
  );
