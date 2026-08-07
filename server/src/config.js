const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  port: 8787,
  // Where tailored resumes get archived, one .tex + one .jd.txt per application.
  archiveDir: path.join(ROOT, '..', 'archive'),
  // Which engine runs the analysis: "cli" | "anthropic" | "openai" | "gemini".
  // "cli" shells out to the Claude CLI and needs no key of its own.
  provider: 'cli',
  // Model id; null uses the provider's default.
  model: null,
  // API keys, by provider id. The matching environment variable always wins,
  // so this file can stay empty if you'd rather export the key.
  apiKeys: {},
  // Ceiling on a single analysis call.
  timeoutMs: 180000,
  // Minutes after startup during which the extension may auto-fetch the token.
  pairWindowMinutes: 5,
};

/**
 * Write config.json owner-only. Node maps mode 0o600 onto a restrictive ACL on
 * Windows too, so this is worth doing on every platform now that the file can
 * hold API keys.
 */
function writeConfig(config) {
  const json = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(CONFIG_PATH, json, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600); // existing files keep their old mode otherwise
  } catch { /* best effort — a failed chmod shouldn't stop the server */ }
}

function load() {
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`Ignoring malformed config.json: ${err.message}`);
    }
  }

  const config = { ...DEFAULTS, ...stored, apiKeys: { ...DEFAULTS.apiKeys, ...stored.apiKeys } };

  // Mint a token on first run so the endpoints aren't open to every local process.
  if (!config.token) {
    config.token = crypto.randomBytes(24).toString('hex');
    writeConfig(config);
    console.log(`Generated a new auth token in ${CONFIG_PATH}`);
  }

  config.archiveDir = path.resolve(ROOT, config.archiveDir);
  return config;
}

module.exports = { load, writeConfig, CONFIG_PATH, ROOT };
