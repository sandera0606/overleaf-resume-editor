#!/usr/bin/env node
/**
 * Command-line face of the same parser/applier the extension uses.
 *
 * This exists so the Claude Code plugin does the *judgment* (which blocks fit
 * the job, how to reword a bullet) while this tested code does the *mechanics*
 * (locating blocks, commenting them without orphaning a delimiter). Hand-editing
 * the LaTeX instead would re-introduce bugs the test suite already covers.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parse } = require('./latex');
const { applySuggestions } = require('./edits');
const archiveLib = require('./archive');
const { load } = require('./config');

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function readFile(p) {
  if (!fs.existsSync(p)) fail(`no such file: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

/** Parse `--key value` and `--flag` pairs out of argv. */
function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const commands = {
  /** Block inventory for a .tex — what Claude picks block ids from. */
  blocks(argv) {
    const opts = flags(argv);
    const file = opts._[0];
    if (!file) fail('usage: cli.js blocks <file.tex> [--json]');

    const doc = parse(readFile(file));

    if (opts.json) {
      console.log(JSON.stringify({
        file,
        sections: doc.sections.filter((s) => s.blocks.length).map((s) => ({ name: s.name, blocks: s.blocks })),
        blocks: doc.blocks.map((b) => ({
          id: b.id, title: b.title, section: b.section,
          commented: b.commented, lines: [b.startLine, b.endLine], text: b.text,
        })),
      }, null, 2));
      return;
    }

    // Human-readable default: the shape matters more than the contents.
    console.log(`${file} — ${doc.blocks.length} blocks, ${doc.lines.length} lines\n`);
    for (const s of doc.sections.filter((x) => x.blocks.length)) {
      console.log(`  ${s.name}`);
      for (const id of s.blocks) {
        const b = doc.blocks.find((x) => x.id === id);
        const mark = b.commented ? 'hidden' : 'shown ';
        console.log(`    [${mark}] ${b.id}`);
        console.log(`              ${b.title}  (L${b.startLine}-${b.endLine})`);
      }
      console.log('');
    }
  },

  /**
   * Apply a suggestion list. Never writes unless told to, so a bad suggestion
   * set costs nothing.
   */
  apply(argv) {
    const opts = flags(argv);
    const file = opts._[0];
    if (!file) fail('usage: cli.js apply <file.tex> --suggestions <file.json|-> [--out <file>|--in-place]');
    if (!opts.suggestions) fail('--suggestions is required (a JSON file, or - for stdin)');

    const source = readFile(file);
    const rawJson = opts.suggestions === '-' ? readStdin() : readFile(opts.suggestions);

    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      fail(`suggestions is not valid JSON: ${err.message}`);
    }
    const list = Array.isArray(parsed) ? parsed : parsed.suggestions;
    if (!Array.isArray(list)) fail('expected a JSON array, or an object with a "suggestions" array');
    if (!list.length) fail('no suggestions to apply');

    const { text, results } = applySuggestions(source, list);

    const applied = results.filter((r) => r.status === 'applied');
    const failed = results.filter((r) => r.status === 'failed');
    const skipped = results.filter((r) => r.status === 'skipped');

    for (const r of results) {
      const mark = { applied: '  ok  ', failed: ' FAIL ', skipped: ' skip ' }[r.status];
      console.error(`[${mark}] ${r.id}${r.reason ? `  ${r.reason}` : ''}`);
    }
    console.error(`\n${applied.length} applied, ${failed.length} failed, ${skipped.length} skipped`);

    // Signal partial failure before any early return — a dry run whose whole
    // purpose is to check applicability must not exit 0 when something failed.
    if (failed.length) process.exitCode = 2;

    if (opts['dry-run']) {
      console.error('(dry run — nothing written)');
      return;
    }

    const dest = opts['in-place'] ? file : opts.out;
    if (!dest) {
      process.stdout.write(text); // let the caller pipe it
      return;
    }

    if (opts['in-place']) {
      fs.writeFileSync(`${file}.bak`, source, 'utf8');
      console.error(`backup: ${file}.bak`);
    }
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
    console.error(`wrote: ${dest}`);
  },

  /** Save a tailored resume next to the job description it was built for. */
  archive(argv) {
    const opts = flags(argv);
    const file = opts._[0];
    if (!file) fail('usage: cli.js archive <file.tex> --label "Company — Role" [--jd <file>]');

    const config = load();
    const written = archiveLib.save({
      archiveDir: opts.dir ? path.resolve(opts.dir) : config.archiveDir,
      label: opts.label || path.basename(file, '.tex'),
      tex: readFile(file),
      jobDescription: opts.jd ? readFile(opts.jd) : '',
      meta: { source: 'cli', from: path.resolve(file) },
    });
    console.log(`archived: ${written.tex}`);
    console.log(`      jd: ${written.jd}`);
  },

  list(argv) {
    const opts = flags(argv);
    const config = load();
    const dir = opts.dir ? path.resolve(opts.dir) : config.archiveDir;
    const entries = archiveLib.list(dir);
    if (!entries.length) {
      console.log(`no archived resumes in ${dir}`);
      return;
    }
    console.log(`${entries.length} archived in ${dir}\n`);
    for (const e of entries) {
      console.log(`  ${e.file}`);
      if (e.label) console.log(`    ${e.label}${e.applied ? `  (${e.applied} edits)` : ''}`);
    }
  },

  help() {
    console.log(`resume optimizer cli

  blocks  <file.tex> [--json]
      List addressable blocks. Use --json to get block ids and text for tailoring.

  apply   <file.tex> --suggestions <file.json|-> [--out <file> | --in-place] [--dry-run]
      Apply suggestions. Prints the result to stdout unless --out/--in-place.
      --in-place writes a .bak first. Exits 2 if any suggestion failed.

  archive <file.tex> --label "Company — Role" [--jd <file>] [--dir <dir>]
      Save a tailored resume alongside its job description.

  list [--dir <dir>]
      Show archived resumes.
`);
  },
};

const [, , cmd, ...rest] = process.argv;
const handler = commands[cmd] || (cmd ? null : commands.help);
if (!handler) fail(`unknown command "${cmd}" — try: blocks, apply, archive, list, help`);
handler(rest);
