// Streaming text translation with a small Gemini model.

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export class RateLimitError extends Error {}

export class GeminiTranslator {
  constructor({ apiKey, model, langA, langB, glossary }) {
    this.apiKey = apiKey;
    this.model = model;
    this.useThinkingConfig = true;
    this.system = [
      `You are a professional real-time interpreter in a meeting between ${langA} and ${langB} speakers.`,
      `The user message contains a speech transcript inside <text>. If it is in ${langA}, translate it into ${langB}; if it is in ${langB}, translate it into ${langA}.`,
      'Output only the translation: no quotes, labels, notes or explanations.',
      'The transcript comes from speech recognition and may contain errors or fillers; infer the intended meaning from context and translate it naturally and concisely.',
      'The text may be an unfinished sentence because the speaker is still talking; translate what is there without inventing a continuation.',
      '<context> holds earlier lines for reference only; never translate it.',
      glossary ? `Background and glossary supplied by the user:\n${glossary}` : '',
    ].filter(Boolean).join('\n');
  }

  // history: [{src, tgt}], onDelta(fullTextSoFar). Resolves with the full translation.
  async translate(text, { history = [], onDelta, signal } = {}) {
    const context = history.map((h) => `${h.src}\n=> ${h.tgt}`).join('\n');
    const prompt = `${context ? `<context>\n${context}\n</context>\n` : ''}<text>\n${text}\n</text>`;
    const body = {
      systemInstruction: { parts: [{ text: this.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    };
    if (this.useThinkingConfig) body.generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };

    const res = await fetch(`${API}/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 400 && this.useThinkingConfig && /thinking/i.test(detail)) {
        // This model doesn't take the thinking option; drop it for good.
        this.useThinkingConfig = false;
        return this.translate(text, { history, onDelta, signal });
      }
      if (res.status === 429) throw new RateLimitError('翻訳APIのレート制限に達しました');
      let message = detail;
      try { message = JSON.parse(detail).error.message; } catch { /* keep raw */ }
      throw new Error(`翻訳エラー (${res.status}): ${message.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const parts = JSON.parse(line.slice(5)).candidates?.[0]?.content?.parts || [];
          const delta = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
          if (delta) { out += delta; onDelta?.(out); }
        } catch { /* partial or keep-alive line */ }
      }
    }
    return out.trim();
  }
}
