/**
 * Structural-integrity tests.
 *
 * The parse tests check that we edit the right *content*; these check the
 * result still compiles. A tailored resume that errors out in pdflatex is
 * worse than one that was never tailored, so these guard the real invariant:
 * every list delimiter that is active must have an active partner.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { parse } = require('../src/latex');
const { applySuggestions } = require('../src/edits');

const SRC = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-resume.tex'), 'utf8');

const PAIRS = [
  ['\\resumeItemListStart', '\\resumeItemListEnd'],
  ['\\resumeSubHeadingListStart', '\\resumeSubHeadingListEnd'],
  ['\\begin{document}', '\\end{document}'],
];

/** Count only delimiters that are actually active (not commented out). */
function activeCounts(text) {
  const counts = new Map();
  for (const line of text.split('\n')) {
    const stripped = line.replace(/^\s*/, '');
    if (stripped.startsWith('%')) continue;
    for (const [open, close] of PAIRS) {
      for (const tok of [open, close]) {
        if (stripped.includes(tok)) counts.set(tok, (counts.get(tok) || 0) + 1);
      }
    }
  }
  return counts;
}

function assertBalanced(text, label) {
  const counts = activeCounts(text);
  for (const [open, close] of PAIRS) {
    const o = counts.get(open) || 0;
    const c = counts.get(close) || 0;
    assert.strictEqual(o, c,
      `${label}: ${open} appears ${o}x but ${close} appears ${c}x — this will not compile.`);
  }
}

test('the fixture itself is balanced', () => {
  assertBalanced(SRC, 'fixture');
});

test('each block fully contains its own item list', () => {
  const doc = parse(SRC);
  for (const b of doc.blocks) {
    const starts = (b.text.match(/\\resumeItemListStart/g) || []).length;
    const ends = (b.text.match(/\\resumeItemListEnd/g) || []).length;
    assert.strictEqual(starts, ends,
      `block "${b.id}" has ${starts} list-starts and ${ends} list-ends; ` +
      `commenting it out would leave a dangling delimiter.`);
  }
});

test('commenting out any single block leaves the document balanced', () => {
  const doc = parse(SRC);
  for (const b of doc.blocks.filter((x) => !x.commented)) {
    const out = applySuggestions(SRC, [{ id: 't', type: 'block_comment', blockId: b.id }]);
    assert.strictEqual(out.results[0].status, 'applied', `could not comment ${b.id}`);
    assertBalanced(out.text, `after commenting "${b.id}"`);
  }
});

test('uncommenting a hidden block leaves the document balanced', () => {
  const doc = parse(SRC);
  for (const b of doc.blocks.filter((x) => x.commented)) {
    const out = applySuggestions(SRC, [{ id: 't', type: 'block_uncomment', blockId: b.id }]);
    assert.strictEqual(out.results[0].status, 'applied', `could not uncomment ${b.id}`);
    assertBalanced(out.text, `after uncommenting "${b.id}"`);
  }
});

test('moving a block leaves the document balanced', () => {
  const doc = parse(SRC);
  const projects = doc.blocks.filter((b) => b.section === 'Projects');
  for (const b of projects) {
    for (const anchor of projects.filter((x) => x.id !== b.id)) {
      const out = applySuggestions(SRC, [
        { id: 't', type: 'block_move', blockId: b.id, afterBlockId: anchor.id },
      ]);
      assert.strictEqual(out.results[0].status, 'applied', `could not move ${b.id} after ${anchor.id}`);
      assertBalanced(out.text, `after moving "${b.id}" after "${anchor.id}"`);
      assert.strictEqual(parse(out.text).blocks.length, doc.blocks.length,
        `moving "${b.id}" changed the block count`);
    }
  }
});

test('a realistic combined edit stays balanced', () => {
  const doc = parse(SRC);
  const kafka = doc.blocks.find((b) => b.title.includes('Kafka'));
  const chess = doc.blocks.find((b) => b.title.includes('Chess'));
  const recipe = doc.blocks.find((b) => b.title.includes('Recipe'));

  const out = applySuggestions(SRC, [
    { id: 's1', type: 'reword', anchor: 'Streaming ingestion service with exactly-once delivery.', replacement: 'Built a streaming ingestion service in Go with exactly-once delivery.' },
    { id: 's2', type: 'block_comment', blockId: recipe.id },
    { id: 's3', type: 'block_uncomment', blockId: chess.id },
    { id: 's4', type: 'block_move', blockId: kafka.id },
  ]);

  assert.ok(out.results.every((r) => r.status === 'applied'),
    `not all applied: ${JSON.stringify(out.results)}`);
  assertBalanced(out.text, 'combined edit');
  assert.strictEqual(parse(out.text).blocks.length, 5);
});

test('commenting then uncommenting preserves indentation exactly', () => {
  const doc = parse(SRC);
  for (const b of doc.blocks.filter((x) => !x.commented)) {
    const off = applySuggestions(SRC, [{ id: 'a', type: 'block_comment', blockId: b.id }]);
    const on = applySuggestions(off.text, [{ id: 'b', type: 'block_uncomment', blockId: b.id }]);
    assert.strictEqual(on.text, SRC, `round-trip of "${b.id}" changed the file`);
  }
});
