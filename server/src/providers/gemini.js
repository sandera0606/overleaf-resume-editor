/**
 * Provider: the Google Gemini API.
 *
 * Gemini's schema dialect is an OpenAPI subset that rejects
 * `additionalProperties`, so the shared schema is stripped before it is sent.
 */

const { SYSTEM_PROMPT, RESPONSE_SCHEMA } = require('../prompt');
const { postJson } = require('./http');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-pro';

/** Recursively drop keywords Gemini's schema validator rejects. */
function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties') continue;
    out[key] = geminiSchema(value);
  }
  return out;
}

async function complete({ prompt, model, apiKey, timeoutMs }) {
  const name = model || DEFAULT_MODEL;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: geminiSchema(RESPONSE_SCHEMA),
    },
  };

  const data = await postJson(`${BASE}/${encodeURIComponent(name)}:generateContent`, body, {
    // Key rides in a header rather than the query string so it stays out of
    // any URL that gets logged.
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs,
    label: 'Gemini',
  });

  if (data.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini blocked this request (${data.promptFeedback.blockReason}). `
      + 'Try again, or switch provider in config.json.',
    );
  }

  const candidate = data.candidates?.[0];
  if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new Error(`Gemini stopped early (${candidate.finishReason}).`);
  }

  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no content.');

  return { text, usage: data.usageMetadata };
}

module.exports = {
  id: 'gemini',
  label: 'Google Gemini API',
  needsKey: true,
  envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  defaultModel: DEFAULT_MODEL,
  keysUrl: 'https://aistudio.google.com/apikey',
  complete,
};
