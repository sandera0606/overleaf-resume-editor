/**
 * Provider registry and key resolution.
 *
 * Keys are resolved environment-first so a user who would rather not have a
 * secret sitting in a JSON file on disk can export it instead. Whichever route
 * they take, the key never leaves this process: the extension asks the server
 * to "analyze this", and the server decides who to call.
 */

const cli = require('./cli');
const anthropic = require('./anthropic');
const openai = require('./openai');
const gemini = require('./gemini');
const { redact } = require('./http');

const PROVIDERS = { cli, anthropic, openai, gemini };
const NAMES = Object.keys(PROVIDERS);

function get(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw Object.assign(
      new Error(`Unknown provider "${id}". Set "provider" in config.json to one of: ${NAMES.join(', ')}.`),
      { status: 400 },
    );
  }
  return provider;
}

/**
 * @returns {{key: string|null, source: string|null}} where the key came from,
 *          so startup can tell the user which one is actually in play.
 */
function resolveKey(provider, config) {
  if (!provider.needsKey) return { key: null, source: null };

  for (const name of provider.envVars || []) {
    const value = process.env[name];
    if (value && value.trim()) return { key: value.trim(), source: `$${name}` };
  }

  const fromConfig = config.apiKeys?.[provider.id];
  if (fromConfig && fromConfig.trim()) return { key: fromConfig.trim(), source: 'config.json' };

  return { key: null, source: null };
}

function missingKeyError(provider) {
  const envList = (provider.envVars || []).map((n) => `$${n}`).join(' or ');
  return Object.assign(
    new Error(
      `No API key for ${provider.label}. Set ${envList}, or put it in "apiKeys.${provider.id}" `
      + `in server/config.json. Get one at ${provider.keysUrl}`,
    ),
    { status: 400 },
  );
}

/** Run one completion against the configured provider. */
async function complete({ prompt, config, cwd }) {
  const provider = get(config.provider || 'cli');
  const { key } = resolveKey(provider, config);
  if (provider.needsKey && !key) throw missingKeyError(provider);

  try {
    return await provider.complete({
      prompt,
      model: config.model,
      apiKey: key,
      cwd,
      timeoutMs: config.timeoutMs,
    });
  } catch (err) {
    // Last line of defence — a provider that echoed the request back would
    // otherwise leak the key into logs and the extension's status bar.
    err.message = redact(err.message);
    throw err;
  }
}

/** Human-readable one-liner for the startup banner. */
function describe(config) {
  const provider = get(config.provider || 'cli');
  const { source } = resolveKey(provider, config);
  const model = config.model || provider.defaultModel || '(provider default)';
  if (!provider.needsKey) return `${provider.label} — model ${model}`;
  return `${provider.label} — model ${model}, key from ${source || 'NOT SET'}`;
}

module.exports = { PROVIDERS, NAMES, get, resolveKey, complete, describe };
