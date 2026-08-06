const fs = require('node:fs');
const path = require('node:path');

function slug(text, fallback = 'application') {
  const s = String(text || '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return s || fallback;
}

/** YYYY-MM-DD in local time. */
function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Save a tailored resume alongside the job description it was tailored to,
 * so the archive stays self-explanatory months later.
 *
 * @returns {{dir: string, tex: string, jd: string, meta: string}} written paths
 */
function save({ archiveDir, label, tex, jobDescription, meta = {} }) {
  fs.mkdirSync(archiveDir, { recursive: true });

  const base = `${today()}_${slug(label)}`;
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(archiveDir, `${name}.tex`))) {
    name = `${base}-${n++}`; // never clobber an earlier application
  }

  const texPath = path.join(archiveDir, `${name}.tex`);
  const jdPath = path.join(archiveDir, `${name}.jd.txt`);
  const metaPath = path.join(archiveDir, `${name}.meta.json`);

  fs.writeFileSync(texPath, tex, 'utf8');
  fs.writeFileSync(jdPath, jobDescription || '', 'utf8');
  fs.writeFileSync(metaPath, `${JSON.stringify({ savedAt: new Date().toISOString(), label, ...meta }, null, 2)}\n`, 'utf8');

  return { dir: archiveDir, tex: texPath, jd: jdPath, meta: metaPath, name };
}

function list(archiveDir) {
  if (!fs.existsSync(archiveDir)) return [];
  return fs.readdirSync(archiveDir)
    .filter((f) => f.endsWith('.tex'))
    .sort()
    .reverse()
    .map((f) => {
      const metaPath = path.join(archiveDir, f.replace(/\.tex$/, '.meta.json'));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* optional */ }
      return { file: f, path: path.join(archiveDir, f), ...meta };
    });
}

module.exports = { save, list, slug, today };
