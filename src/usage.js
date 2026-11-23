// What a session used of the Gemini API, counted so that its cost can be estimated (src/pricing.js).
// Pure functions, DOM-free. Every function returns a new record and leaves its arguments unchanged.
//
// A usage record is plain JSON:
//   {
//     version: 1,
//     transcription: { [model]: { listeningMs } },
//     translation:   { [model]: { requests, inputTokens, outputTokens } },
//     summary:       { [model]: { requests, inputTokens, outputTokens } },
//     diarization:   { [model]: { requests, inputTokens, outputTokens } },  (speaker labels)
//   }
// A record written before `diarization` existed reads as having none.
// Output tokens include thinking tokens, which are billed as output.

export const USAGE_VERSION = 1;

/** Kinds counted in tokens; transcription is counted in listening time. */
export const TOKEN_KINDS = ['translation', 'summary', 'diarization'];

const KINDS = ['transcription', ...TOKEN_KINDS];

/** A record with nothing used. */
export function emptyUsage() {
  return { version: USAGE_VERSION, transcription: {}, translation: {}, summary: {}, diarization: {} };
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function checkModel(model) {
  if (typeof model !== 'string' || !model || model === '__proto__') throw new TypeError('A model name is needed');
}

/**
 * The tokens of one response, from the API's `usageMetadata` (GenerateContentResponse.usageMetadata):
 * `promptTokenCount` is input; `candidatesTokenCount` plus `thoughtsTokenCount` is output. Missing, negative
 * or non-numeric fields count as 0, and anything but an object gives zeros. For a streamed response, pass the
 * usageMetadata of the last chunk.
 */
export function usageFromMetadata(usageMetadata) {
  const md = usageMetadata && typeof usageMetadata === 'object' ? usageMetadata : {};
  return {
    inputTokens: count(md.promptTokenCount),
    outputTokens: count(md.candidatesTokenCount) + count(md.thoughtsTokenCount),
  };
}

/** Adds one request of `kind` ('translation', 'summary' or 'diarization') to `model`, with the tokens in `usageMetadata`. */
export function addTokens(usage, kind, model, usageMetadata) {
  if (!TOKEN_KINDS.includes(kind)) throw new TypeError(`Unknown token kind: ${kind}`);
  checkModel(model);
  const { inputTokens, outputTokens } = usageFromMetadata(usageMetadata);
  return addUsage(usage, { [kind]: { [model]: { requests: 1, inputTokens, outputTokens } } });
}

/** Adds `ms` milliseconds of listening with the transcription `model`. Throws a RangeError for a bad duration. */
export function addListening(usage, model, ms) {
  checkModel(model);
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new RangeError('Listening time must be ms >= 0');
  return addUsage(usage, { transcription: { [model]: { listeningMs: ms } } });
}

function addEntries(kind, a = {}, b = {}) {
  const fields = kind === 'transcription' ? ['listeningMs'] : ['requests', 'inputTokens', 'outputTokens'];
  const sum = {};
  for (const source of [a, b]) {
    if (!source || typeof source !== 'object') continue;
    for (const [model, entry] of Object.entries(source)) {
      if (model === '__proto__' || !entry || typeof entry !== 'object') continue;
      sum[model] ??= Object.fromEntries(fields.map((field) => [field, 0]));
      for (const field of fields) sum[model][field] += count(entry[field]);
    }
  }
  return sum;
}

/**
 * The sum of two records, for example to total several sessions. Either may be partial (a missing kind or
 * field counts as nothing; a negative or non-numeric count as 0). Throws a RangeError for a record of a newer
 * version than this code knows.
 */
export function addUsage(a, b) {
  for (const record of [a, b]) {
    if (record?.version > USAGE_VERSION) throw new RangeError(`Usage record version ${record.version} is not known`);
  }
  const result = { version: USAGE_VERSION };
  for (const kind of KINDS) result[kind] = addEntries(kind, a?.[kind], b?.[kind]);
  return result;
}
