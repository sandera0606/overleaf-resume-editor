#!/usr/bin/env node
/**
 * Local bridge between the Chrome extension and Claude CLI.
 *
 * Binds to 127.0.0.1 only. Every route except /health and /pair requires the
 * token from config.json; /pair hands that token out for a few minutes after
 * startup so the extension can configure itself without copy-paste.
 */

const http = require('node:http');
const { load } = require('./config');
const { readTexFiles } = require('./zip');
const { parse } = require('./latex');
const { applySuggestions } = require('./edits');
const { analyze } = require('./claude');
const archive = require('./archive');

const config = load();
const STARTED_AT = Date.now();
const PAIR_WINDOW_MS = config.pairWindowMinutes * 60 * 1000;
const MAX_BODY = 25 * 1024 * 1024; // Overleaf zips with images can get chunky

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error(`Invalid JSON body: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

/** Summarise a .tex for the picker without shipping the whole inventory twice. */
function describe(file) {
  const doc = parse(file.source);
  return {
    name: file.name,
    blocks: doc.blocks.length,
    active: doc.blocks.filter((b) => !b.commented).length,
    hidden: doc.blocks.filter((b) => b.commented).length,
    sections: doc.sections.filter((s) => s.blocks.length).map((s) => s.name),
    lines: doc.lines.length,
  };
}

const routes = {
  'GET /health': async () => ({
    ok: true,
    service: 'resume-optimizer',
    archiveDir: config.archiveDir,
    model: config.model || '(CLI default)',
  }),

  'GET /pair': async () => {
    if (Date.now() - STARTED_AT > PAIR_WINDOW_MS) {
      const err = new Error(`Pairing window closed. Restart the server, or copy the token from config.json.`);
      err.status = 403;
      throw err;
    }
    return { token: config.token };
  },

  // Body: { zipBase64 } -> inventory of every .tex in the project.
  'POST /project': async (body) => {
    if (!body.zipBase64) throw Object.assign(new Error('Missing zipBase64.'), { status: 400 });
    const files = readTexFiles(Buffer.from(body.zipBase64, 'base64'));
    if (!files.length) throw Object.assign(new Error('No .tex files found in that project.'), { status: 422 });
    return { files: files.map(describe), sources: Object.fromEntries(files.map((f) => [f.name, f.source])) };
  },

  // Body: { source, filename } -> parsed block inventory for one file.
  'POST /blocks': async (body) => {
    if (typeof body.source !== 'string') throw Object.assign(new Error('Missing source.'), { status: 400 });
    const doc = parse(body.source);
    return { blocks: doc.blocks, sections: doc.sections };
  },

  // Body: { jobDescription, source, filename } -> Claude's suggestions.
  'POST /analyze': async (body) => {
    const { jobDescription, source, filename = 'resume.tex' } = body;
    if (!jobDescription || !jobDescription.trim()) {
      throw Object.assign(new Error('Paste a job description first.'), { status: 400 });
    }
    if (typeof source !== 'string' || !source.trim()) {
      throw Object.assign(new Error('Missing resume source.'), { status: 400 });
    }

    const doc = parse(source);
    if (!doc.blocks.length) {
      throw Object.assign(new Error(
        'No addressable blocks found. Your template may use macros this parser does not know — ' +
        'wrap items in "% >>> BLOCK: Name" / "% <<< END" comments, or add your macro to headingMacros in config.json.',
      ), { status: 422 });
    }

    console.log(`Analyzing ${filename}: ${doc.blocks.length} blocks, JD ${jobDescription.length} chars`);
    const t0 = Date.now();
    const result = await analyze({ jobDescription, doc, source, filename, model: config.model });
    console.log(`  -> ${result.suggestions.length} suggestions in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ''));
    if (result.rejected.length) console.log(`  -> dropped ${result.rejected.length} malformed:`, result.rejected);

    return { ...result, blocks: doc.blocks };
  },

  // Body: { source, suggestions } -> edited text plus a per-suggestion report.
  'POST /apply': async (body) => {
    if (typeof body.source !== 'string') throw Object.assign(new Error('Missing source.'), { status: 400 });
    const accepted = Array.isArray(body.suggestions) ? body.suggestions : [];
    if (!accepted.length) throw Object.assign(new Error('No suggestions selected.'), { status: 400 });

    const { text, results } = applySuggestions(body.source, accepted);
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) console.log(`  -> ${failed.length} suggestion(s) could not be applied:`, failed);
    return { text, results, changed: text !== body.source };
  },

  // Body: { label, tex, jobDescription, meta } -> archived file paths.
  'POST /archive': async (body) => {
    if (typeof body.tex !== 'string' || !body.tex.trim()) {
      throw Object.assign(new Error('Nothing to archive.'), { status: 400 });
    }
    const written = archive.save({
      archiveDir: config.archiveDir,
      label: body.label,
      tex: body.tex,
      jobDescription: body.jobDescription,
      meta: body.meta,
    });
    console.log(`Archived ${written.tex}`);
    return written;
  },

  'GET /archive': async () => ({ entries: archive.list(config.archiveDir) }),
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: `No route for ${key}` });

  const isOpen = key === 'GET /health' || key === 'GET /pair';
  if (!isOpen && req.headers['x-auth-token'] !== config.token) {
    return send(res, 401, { error: 'Bad or missing X-Auth-Token. Restart the server and re-pair the extension.' });
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await handler(body, url));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`${key} failed:`, err);
    else console.warn(`${key}: ${err.message}`);
    send(res, status, { error: err.message });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`\n  Resume optimizer listening on http://127.0.0.1:${config.port}`);
  console.log(`  Archive:  ${config.archiveDir}`);
  console.log(`  Model:    ${config.model || '(CLI default)'}`);
  console.log(`  Pairing:  open for ${config.pairWindowMinutes} min — click "Connect" in the extension now.\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Is the server already running? ` +
      `Change "port" in config.json to use a different one.`);
    process.exit(1);
  }
  throw err;
});
