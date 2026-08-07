/**
 * Selection and ordering. These pin the behaviours a user would notice:
 * relevant things survive, the page budget is respected, dated sections stay
 * chronological, and undated ones lead with the most relevant block.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { parse } = require('../src/latex');
const { selectToFit, parseDate, sectionIsDated } = require('../src/select');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-resume.tex'), 'utf8');

test('parses the latest date out of a range', () => {
  const may = parseDate('May 2026');
  const aug = parseDate('May 2026 -- Aug 2026');
  assert.ok(aug > may, 'a range should sort on its end date');
  assert.ok(parseDate('Jan 2026 -- Apr 2026') < aug);
});

test('ongoing roles sort above every finished one', () => {
  assert.ok(parseDate('Jan 2020 -- Present') > parseDate('May 2026 -- Aug 2026'));
});

test('year-only dates still order against each other', () => {
  assert.ok(parseDate('2026') > parseDate('2024'));
  assert.strictEqual(parseDate('no date here at all'), null);
});

test('a section is dated only when most of its blocks carry dates', () => {
  const dated = [{ text: 'May 2026' }, { text: 'Jan 2025' }, { text: 'nothing' }];
  const undated = [{ text: 'nothing' }, { text: 'also nothing' }, { text: 'Jan 2025' }];
  assert.strictEqual(sectionIsDated(dated), true);
  assert.strictEqual(sectionIsDated(undated), false);
  assert.strictEqual(sectionIsDated([]), false);
});

test('higher-ranked blocks are chosen over lower-ranked ones', () => {
  const doc = parse(FIXTURE);
  assert.ok(doc.blocks.length >= 3, 'fixture needs blocks to select from');

  const top = doc.blocks[doc.blocks.length - 1].id; // deliberately the last one
  const ranking = Object.fromEntries(doc.blocks.map((b) => [b.id, b.id === top ? 100 : 1]));

  // Derive a tight budget from what the content actually costs, rather than
  // hard-coding points: a fixed number silently stops being tight the moment
  // the estimator is recalibrated, and the test passes while asserting nothing.
  const full = selectToFit(doc, ranking, { source: FIXTURE, budgetPt: 100000 });
  const tight = full.estimate.overheadPt + (full.estimate.usedPt - full.estimate.overheadPt) * 0.5;

  const res = selectToFit(doc, ranking, { source: FIXTURE, budgetPt: tight });
  assert.ok(res.show.includes(top), 'the highest-ranked block must survive a tight budget');
  assert.ok(res.hide.length > 0, 'a tight budget must drop something');
});

test('the page budget is never exceeded', () => {
  const doc = parse(FIXTURE);
  const ranking = Object.fromEntries(doc.blocks.map((b, i) => [b.id, i]));
  for (const budgetPt of [200, 300, 450, 700]) {
    const res = selectToFit(doc, ranking, { source: FIXTURE, budgetPt });
    assert.ok(res.estimate.usedPt <= budgetPt,
      `budget ${budgetPt}pt exceeded: used ${res.estimate.usedPt}pt`);
  }
});

test('a bigger budget never shows fewer blocks', () => {
  const doc = parse(FIXTURE);
  const ranking = Object.fromEntries(doc.blocks.map((b, i) => [b.id, i]));
  let previous = -1;
  for (const budgetPt of [200, 300, 450, 700, 1200]) {
    const { show } = selectToFit(doc, ranking, { source: FIXTURE, budgetPt });
    assert.ok(show.length >= previous, `budget ${budgetPt}pt showed fewer blocks than a smaller budget`);
    previous = show.length;
  }
});

test('every block is either shown or hidden, never both, never lost', () => {
  const doc = parse(FIXTURE);
  const ranking = Object.fromEntries(doc.blocks.map((b, i) => [b.id, i]));
  const res = selectToFit(doc, ranking, { source: FIXTURE, budgetPt: 400 });
  const all = [...res.show, ...res.hide];
  assert.strictEqual(new Set(all).size, all.length, 'a block appeared twice');
  assert.strictEqual(all.length, doc.blocks.length, 'a block went missing');
});

test('order contains exactly the shown blocks', () => {
  const doc = parse(FIXTURE);
  const ranking = Object.fromEntries(doc.blocks.map((b, i) => [b.id, i]));
  const res = selectToFit(doc, ranking, { source: FIXTURE, budgetPt: 500 });
  assert.deepStrictEqual([...res.order].sort(), [...res.show].sort());
});

test('dated sections come out newest-first regardless of relevance', () => {
  const src = [
    '\\documentclass[letterpaper,11pt]{article}',
    '\\begin{document}',
    '\\section{Experience}',
    '\\resumeSubheading{Old Role}{Jan 2020 -- Dec 2020}{Org}{Loc}',
    '\\resumeSubheading{Newest Role}{Jan 2026 -- Aug 2026}{Org}{Loc}',
    '\\resumeSubheading{Middle Role}{Jan 2023 -- Dec 2023}{Org}{Loc}',
    '\\end{document}',
  ].join('\n');
  const doc = parse(src);
  assert.strictEqual(doc.blocks.length, 3, 'expected three dated blocks');

  // Rank the OLDEST highest — chronology must still win in a dated section.
  const ranking = { [doc.blocks[0].id]: 100, [doc.blocks[1].id]: 1, [doc.blocks[2].id]: 50 };
  const res = selectToFit(doc, ranking, { source: src, budgetPt: 4000 });

  const section = res.sections.find((s) => s.name === 'Experience');
  assert.strictEqual(section.ordering, 'chronological');
  assert.strictEqual(section.blocks[0], doc.blocks[1].id, 'newest role should lead');
  assert.strictEqual(section.blocks[2], doc.blocks[0].id, 'oldest role should trail');
});

test('undated sections lead with the most relevant block', () => {
  const src = [
    '\\documentclass[letterpaper,11pt]{article}',
    '\\begin{document}',
    '\\section{Projects}',
    '\\resumeProjectHeading{\\textbf{Alpha}}{}',
    '\\resumeProjectHeading{\\textbf{Beta}}{}',
    '\\resumeProjectHeading{\\textbf{Gamma}}{}',
    '\\end{document}',
  ].join('\n');
  const doc = parse(src);
  const ranking = { [doc.blocks[0].id]: 5, [doc.blocks[1].id]: 99, [doc.blocks[2].id]: 50 };
  const res = selectToFit(doc, ranking, { source: src, budgetPt: 4000 });

  const section = res.sections.find((s) => s.name === 'Projects');
  assert.strictEqual(section.ordering, 'relevance');
  assert.strictEqual(section.blocks[0], doc.blocks[1].id, 'highest relevance should lead');
  assert.strictEqual(section.blocks[2], doc.blocks[0].id, 'lowest relevance should trail');
});

test('currently-hidden blocks are costed at their shown size', () => {
  const shownSrc = [
    '\\documentclass[letterpaper,11pt]{article}', '\\begin{document}', '\\section{Projects}',
    '\\resumeProjectHeading{\\textbf{Alpha}}{}', '\\end{document}',
  ].join('\n');
  const hiddenSrc = shownSrc.replace('\\resumeProjectHeading{\\textbf{Alpha}}{}', '% \\resumeProjectHeading{\\textbf{Alpha}}{}');

  const a = parse(shownSrc);
  const b = parse(hiddenSrc);
  const ra = selectToFit(a, { [a.blocks[0].id]: 10 }, { source: shownSrc, budgetPt: 4000 });
  const rb = selectToFit(b, { [b.blocks[0].id]: 10 }, { source: hiddenSrc, budgetPt: 4000 });

  // A hidden block must not look free, or un-hiding it would blow the budget.
  assert.ok(rb.estimate.usedPt >= ra.estimate.usedPt * 0.9,
    `hidden block costed as ${rb.estimate.usedPt}pt vs shown ${ra.estimate.usedPt}pt`);
});

test('unranked blocks are treated as least relevant, not dropped from the run', () => {
  const doc = parse(FIXTURE);
  const res = selectToFit(doc, {}, { source: FIXTURE, budgetPt: 4000 });
  assert.strictEqual(res.show.length + res.hide.length, doc.blocks.length);
});

test('a bare year in prose does not make a section chronological', () => {
  const { hasExplicitDate } = require('../src/select');
  assert.strictEqual(hasExplicitDate('Handled 2000 requests per second'), false,
    'a bare number must not read as a date');
  assert.strictEqual(hasExplicitDate('Built with Python 3 in 2021'), false,
    'a bare year in prose must not read as a date');
  assert.strictEqual(hasExplicitDate('May 2026 -- Aug 2026'), true);
  assert.strictEqual(hasExplicitDate('Jan 2020 -- Present'), true);
  // ...but bare years still order already-dated blocks against each other.
  assert.ok(parseDate('2026') > parseDate('2024'));
});

test('a block hidden inside a VISIBLE section stays addressable', () => {
  // This is the supported way to park content: comment the block, keep the
  // \section heading visible.
  const doc = parse(FIXTURE);
  const hidden = doc.blocks.filter((b) => b.commented);
  assert.ok(hidden.length > 0, 'fixture should contain a commented-out block');
  const res = selectToFit(doc, { [hidden[0].id]: 100 }, { source: FIXTURE, budgetPt: 4000 });
  assert.ok(res.show.includes(hidden[0].id), 'a hidden block must be selectable again');
});

test('blocks inside a fully commented-out section are not addressable', () => {
  // Documented limitation: commenting the \section line hides its blocks from
  // the parser entirely, so selection can never surface them. The README tells
  // users to comment blocks rather than whole sections; this test exists so the
  // day that changes, it changes deliberately.
  const extra = [
    '',
    '% \section{Awards and Achievements}',
    '%   \resumeSubHeadingListStart',
    '%     \resumeProjectHeading',
    '%       {\textbf{Departmental Scholarship}}{2024}',
    '%       \resumeItemListStart',
    '%         \resumeItem{Awarded for academic standing.}',
    '%       \resumeItemListEnd',
    '%   \resumeSubHeadingListEnd',
  ].join(String.fromCharCode(10));
  const doc = parse(FIXTURE + extra);
  assert.ok(!doc.blocks.some((b) => /scholarship/i.test(b.text)),
    'if this now passes, the parser gained commented-section support — update the README');
});
