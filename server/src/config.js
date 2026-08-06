const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  port: 8787,
  // Where tailored resumes get archived, one .tex + one .jd.txt per application.
  archiveDir: path.join(ROOT, '..', 'archive'),
  // Claude model alias; null uses whatever your CLI defaults to.
  model: null,
  // Minutes after startup during which the extension may auto-fetch the token.
  pairWindowMinutes: 5,
};

function load() {
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`Ignoring malformed config.json: ${err.message}`);
    }
  }

  const config = { ...DEFAULTS, ...stored };

  // Mint a token on first run so the endpoints aren't open to every local process.
  if (!config.token) {
    config.token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Generated a new auth token in ${CONFIG_PATH}`);
  }

  config.archiveDir = path.resolve(ROOT, config.archiveDir);
  return config;
}

module.exports = { load, CONFIG_PATH, ROOT };
