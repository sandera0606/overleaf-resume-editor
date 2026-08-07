/**
 * Provider: the Anthropic Messages API.
 *
 * Raw HTTPS rather than the official SDK, because this server is deliberately
 * dependency-free — adding an SDK would put an `npm install` between the user
 * and a working setup, which is the friction this project exists to remove.
 */

const { SYSTEM_PROMPT, RESPONSE_SCHEMA } = require('../prompt');
const { postJson } = require('./http');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5';
// Thinking is on by default on current models and shares this ceiling with the
// visible reply, so leave real headroom or answers truncate mid-object.
const MAX_TOKENS = 16000;

async function complete({ prompt, model, apiKey, timeoutMs }) {
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    // Schema-constrained decoding: the reply is guaranteed to parse, so the
    // brace-scanning fallback in prompt.js becomes a belt-and-braces path.
    output_config: {
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
  };

  const data = await postJson(ENDPOINT, body, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    timeoutMs,
    label: 'Anthropic',
  });

  if (data.stop_reason === 'refusal') {
    const category = data.stop_details?.category;
    throw new Error(
      `Anthropic declined this request${category ? ` (${category})` : ''}. `
      + 'This is usually a false positive on benign text — try again, or switch provider in config.json.',
    );
  }

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!text) {
    throw new Error(`Anthropic returned no text (stop_reason: ${data.stop_reason || 'unknown'}).`);
  }

  return { text, usage: data.usage };
}

module.exports = {
  id: 'anthropic',
  label: 'Anthropic API',
  needsKey: true,
  envVars: ['ANTHROPIC_API_KEY'],
  defaultModel: DEFAULT_MODEL,
  keysUrl: 'https://console.anthropic.com/settings/keys',
  complete,
};
