const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { parse } = require('../src/latex');
const { applySuggestions } = require('../src/edits');

const SRC = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-resume.tex'), 'utf8');

test('finds every block across both sections', () => {
  const doc = parse(SRC);
  const ids = doc.blocks.map((b) => b.id);
  assert.strictEqual(doc.blocks.length, 5, `expected 5 blocks, got ${ids.join(', ')}`);
  assert.ok(ids.includes('backend-engineer'));
  assert.ok(ids.includes('software-developer-intern'));
});

test('assigns blocks to their enclosing section', () => {
  const doc = parse(SRC);
  const byId = Object.fromEntries(doc.blocks.map((b) => [b.id, b]));
  assert.strictEqual(byId['backend-engineer'].section, 'Experience');
  const kafka = doc.blocks.find((b) => b.title.includes('Kafka'));
  assert.strictEqual(kafka.section, 'Projects');
});

test('detects a fully commented-out block', () => {
  const doc = parse(SRC);
  const chess = doc.blocks.find((b) => b.title.includes('Chess'));
  assert.ok(chess, 'commented Chess Engine block should still be discovered');
  assert.strictEqual(chess.commented, true);

  const kafka = doc.blocks.find((b) => b.title.includes('Kafka'));
  assert.strictEqual(kafka.commented, false);
});

test('each block is listed under exactly one section, once', () => {
  const doc = parse(SRC);
  const listed = doc.sections.flatMap((s) => s.blocks);

  assert.strictEqual(listed.length, doc.blocks.length,
    `sections list ${listed.length} block ids but there are ${doc.blocks.length} blocks`);
  assert.strictEqual(new Set(listed).size, listed.length, 'a block id appears in section.blocks more than once');

  for (const b of doc.blocks) {
    const owners = doc.sections.filter((s) => s.blocks.includes(b.id));
    assert.strictEqual(owners.length, 1, `block "${b.id}" is listed under ${owners.length} sections`);
    assert.strictEqual(owners[0].name, b.section, `block "${b.id}" is filed under the wrong section`);
  }
});

test('sections with duplicate names keep their own blocks', () => {
  // Two \section{Projects} headings must not merge — the name-based lookup
  // this replaced would file every block under the first one.
  const src = [
    '\\section{Projects}',
    '\\resumeProjectHeading',
    '  {\\textbf{Alpha}}{2021}',
    '',
    '\\section{Projects}',
    '\\resumeProjectHeading',
    '  {\\textbf{Beta}}{2022}',
  ].join('\n');

  const doc = parse(src);
  const projectSections = doc.sections.filter((s) => s.name === 'Projects');
  assert.strictEqual(projectSections.length, 2);
  assert.deepStrictEqual(projectSections.map((s) => s.blocks), [['alpha'], ['beta']]);
});

test('block ranges do not overlap and stay inside the file', () => {
  const doc = parse(SRC);
  const sorted = [...doc.blocks].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].startLine > sorted[i - 1].endLine,
      `block ${sorted[i].id} overlaps ${sorted[i - 1].id}`);
  }
  const total = SRC.split('\n').length;
  for (const b of sorted) assert.ok(b.endLine <= total);
});

test('comment then uncomment round-trips exactly', () => {
  const doc = parse(SRC);
  const kafka = doc.blocks.find((b) => b.title.includes('Kafka'));

  const off = applySuggestions(SRC, [{ id: 's1', type: 'block_comment', blockId: kafka.id }]);
  assert.strictEqual(off.results[0].status, 'applied');
  assert.ok(parse(off.text).blocks.find((b) => b.title.includes('Kafka')).commented);

  const back = applySuggestions(off.text, [{ id: 's2', type: 'block_uncomment', blockId: kafka.id }]);
  assert.strictEqual(back.results[0].status, 'applied');
  assert.strictEqual(back.text, SRC, 'round-trip should restore the file byte-for-byte');
});

test('uncommenting a disabled block reactivates it', () => {
  const doc = parse(SRC);
  const chess = doc.blocks.find((b) => b.title.includes('Chess'));
  const out = applySuggestions(SRC, [{ id: 's1', type: 'block_uncomment', blockId: chess.id }]);
  assert.strictEqual(out.results[0].status, 'applied');
  const after = parse(out.text).blocks.find((b) => b.title.includes('Chess'));
  assert.strictEqual(after.commented, false);
  assert.ok(out.text.includes('\\resumeItem{Alpha-beta search'));
});

test('reword replaces anchored text', () => {
  const out = applySuggestions(SRC, [{
    id: 's1',
    type: 'reword',
    anchor: 'Worked on the internal asset registry API.',
    replacement: 'Designed and shipped the internal asset registry API serving 40+ services.',
  }]);
  assert.strictEqual(out.results[0].status, 'applied');
  assert.ok(out.text.includes('serving 40+ services'));
  assert.ok(!out.text.includes('Worked on the internal'));
});

test('reword fails loudly rather than guessing when the anchor is gone', () => {
  const out = applySuggestions(SRC, [{
    id: 's1',
    type: 'reword',
    anchor: 'This sentence is not in the resume at all.',
    replacement: 'nope',
  }]);
  assert.strictEqual(out.results[0].status, 'failed');
  assert.strictEqual(out.text, SRC, 'a failed suggestion must not modify the file');
});

test('multiple edits in one pass do not corrupt each other', () => {
  const doc = parse(SRC);
  const kafka = doc.blocks.find((b) => b.title.includes('Kafka'));
  const chess = doc.blocks.find((b) => b.title.includes('Chess'));
  const recipe = doc.blocks.find((b) => b.title.includes('Recipe'));

  const out = applySuggestions(SRC, [
    { id: 'a', type: 'reword', anchor: 'Made improvements to the reporting dashboard.', replacement: 'Rebuilt the reporting dashboard, cutting load time 60%.' },
    { id: 'b', type: 'block_uncomment', blockId: chess.id },
    { id: 'c', type: 'block_comment', blockId: recipe.id },
  ]);

  assert.deepStrictEqual(out.results.map((r) => r.status), ['applied', 'applied', 'applied']);
  const after = parse(out.text);
  assert.strictEqual(after.blocks.find((b) => b.title.includes('Chess')).commented, false);
  assert.strictEqual(after.blocks.find((b) => b.title.includes('Recipe')).commented, true);
  assert.strictEqual(after.blocks.find((b) => b.title.includes('Kafka')).commented, false, 'untouched block must be unaffected');
  assert.ok(out.text.includes('cutting load time 60%'));
  assert.strictEqual(after.blocks.length, 5, 'block count must be stable across edits');
});

test('moving a block reorders without losing content', () => {
  const doc = parse(SRC);
  const recipe = doc.blocks.find((b) => b.title.includes('Recipe'));
  const kafka = doc.blocks.find((b) => b.title.includes('Kafka'));

  const out = applySuggestions(SRC, [
    { id: 's1', type: 'block_move', blockId: recipe.id, afterBlockId: kafka.id },
  ]);
  assert.strictEqual(out.results[0].status, 'applied');

  const after = parse(out.text);
  assert.strictEqual(after.blocks.length, 5, 'move must not drop or duplicate blocks');
  const order = after.blocks.filter((b) => b.section === 'Projects').map((b) => b.title);
  assert.ok(order.findIndex((t) => t.includes('Recipe')) < order.findIndex((t) => t.includes('Chess')),
    `Recipe should now precede Chess; got ${order.join(' | ')}`);
  assert.ok(out.text.includes('Full-stack recipe sharing app'));
});
