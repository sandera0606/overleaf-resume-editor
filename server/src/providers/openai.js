/**
 * Provider: the OpenAI Chat Completions API.
 *
 * Uses strict structured outputs, which requires every property to be listed in
 * `required` — hence the nullable-instead-of-optional schema variant. The
 * nulls are stripped again in prompt.js#normalize.
 */

const { SYSTEM_PROMPT, strictSchema } = require('../prompt');
const { postJson } = require('./http');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o';

async function complete({ prompt, model, apiKey, timeoutMs }) {
  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'resume_suggestions', strict: true, schema: strictSchema() },
    },
  };

  const data = await postJson(ENDPOINT, body, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs,
    label: 'OpenAI',
  });

  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'content_filter') {
    throw new Error('OpenAI\'s content filter blocked this request. Try again, or switch provider in config.json.');
  }
  if (choice?.finish_reason === 'length') {
    throw new Error('OpenAI hit its output limit before finishing. Trim the job description and retry.');
  }

  const text = choice?.message?.content;
  if (!text) throw new Error('OpenAI returned no content.');

  return { text, usage: data.usage };
}

module.exports = {
  id: 'openai',
  label: 'OpenAI API',
  needsKey: true,
  envVars: ['OPENAI_API_KEY'],
  defaultModel: DEFAULT_MODEL,
  keysUrl: 'https://platform.openai.com/api-keys',
  complete,
};
