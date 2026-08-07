/**
 * The analysis entry point: prompt -> provider -> validated suggestions.
 *
 * Provider choice lives in config.js; everything downstream of this file is
 * provider-agnostic, so a suggestion from Gemini applies exactly like one from
 * the Claude CLI.
 */

const providers = require('./providers');
const { buildPrompt, extractJson, normalize, SYSTEM_PROMPT } = require('./prompt');

async function analyze({ jobDescription, doc, source, filename, config, cwd }) {
  const prompt = buildPrompt({ jobDescription, doc, source, filename });
  const { text, cost, usage } = await providers.complete({ prompt, config, cwd });

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    throw Object.assign(
      new Error(`${err.message} Try re-running; if it repeats, the model or job description may be at fault.`),
      { status: 502 },
    );
  }

  return { ...normalize(parsed), cost, usage };
}

module.exports = { analyze, buildPrompt, extractJson, normalize, SYSTEM_PROMPT };
