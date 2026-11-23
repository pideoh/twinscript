// Mock of the summary request (the one whose prompt holds a <transcript>).

// Mocks the summary request (the one whose prompt holds a <transcript>), leaving translation
// requests to mockGemini. `respond(request)` returns { status, body } where body is the model's
// JSON text for a 200, or the raw error body otherwise. Returns the requests seen.
export async function mockSummary(page, respond) {
  const requests = [];
  await page.route(/streamGenerateContent/, async (route) => {
    const request = route.request().postDataJSON();
    if (!request.contents[0].parts[0].text.startsWith('<transcript>')) return route.fallback();
    requests.push(request);
    const { status = 200, body } = await respond(request);
    if (status !== 200) return route.fulfill({ status, contentType: 'application/json', body });
    const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: body }] } }] })}\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  });
  return requests;
}
