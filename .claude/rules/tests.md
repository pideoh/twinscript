---
paths:
  - "test/**"
---

# Tests

- Unit tests use `node:test` and `node:assert/strict` only. No test dependencies.
- Browser tests (`test/e2e/*.e2e.js`, with shared setup in `test/e2e/helpers.js`) run real Chrome with a fake microphone; the Gemini endpoints are mocked: `mockGemini` (the WebSocket and the token request, which `openApp` answers by default) and `page.route` (translation and summary over HTTP). Never call the real API from a test.
- `openApp()` seeds `uiLang: 'ja'` by default, so most assertions are on Japanese text; pass another `uiLang` or a `locale` option to test other languages.
- A bug fix starts with a test that reproduces it and fails. For transcript segmentation, build the case from the recognizer output that went wrong (`?debug=1` logs it) in `test/segmenter.test.js`.
- Test names say what the user gets, not which function is called.
- When a test has to wait, wait for a condition (`waitForFunction`), not for a duration.
