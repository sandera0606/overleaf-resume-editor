/**
 * The layout estimator is approximate by construction, so these tests pin the
 * things that must be exactly right (geometry parsing, what counts as visible,
 * monotonicity) rather than asserting a height in points, which would just
 * freeze today's fudge factors.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { estimate, readGeometry, visibleText, wrappedLines, toPt, PT_PER_INCH } = require('../src/layout');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-resume.tex'), 'utf8');

// Jake-style preamble: the geometry every one of these templates starts from.
const PREAMBLE = `\\documentclass[letterpaper,11pt]{article}
\\addtolength{\\oddsidemargin}{-0.5in}
\\addtolength{\\textwidth}{1in}
\\addtolength{\\topmargin}{-.5in}
\\addtolength{\\textheight}{1.0in}
\\begin{document}
`;

test('dimension parsing covers the units LaTeX preambles actually use', () => {
  assert.strictEqual(Math.round(toPt('1in')), 72);
  assert.strictEqual(Math.round(toPt('-0.5in')), -36);
  assert.strictEqual(toPt('13.6pt'), 13.6);
  assert.strictEqual(toPt('20'), 20);
  assert.strictEqual(Math.round(toPt('1cm')), 28);
  assert.strictEqual(toPt('2em', 11), 22);
  assert.strictEqual(toPt('garbage'), 0);
});

test('reads font size and applies \\addtolength to the class defaults', () => {
  const geo = readGeometry(PREAMBLE);
  assert.strictEqual(geo.fontSize, 11);
  // 360pt default + 1in
  assert.strictEqual(Math.round(geo.textWidth), Math.round(360 + PT_PER_INCH));
  assert.strictEqual(Math.round(geo.textHeight), Math.round(550 + PT_PER_INCH));
});

test('\\setlength overrides the accumulated default', () => {
  const geo = readGeometry(`${PREAMBLE}\\setlength{\\textwidth}{400pt}`);
  assert.strictEqual(geo.textWidth, 400);
});

test('geometry can come from the style file rather than the .tex', () => {
  const bare = '\\documentclass[letterpaper,11pt]{article}\n\\usepackage{styles/resume-style}\n';
  const sty = '\\addtolength{\\textheight}{1.0in}\n';
  const withSty = readGeometry(bare, sty);
  const without = readGeometry(bare);
  assert.ok(withSty.textHeight > without.textHeight, 'style file should contribute geometry');
});

test('visibleText measures what renders, not the markup', () => {
  const out = visibleText('\\resumeItem{Built a \\textbf{forkable} pipeline.}');
  assert.ok(out.includes('Built a'), out);
  assert.ok(out.includes('forkable'), out);
  assert.ok(!out.includes('textbf'), out);
  assert.ok(!out.includes('\\'), out);
});

test('link targets do not count toward width', () => {
  const withUrl = visibleText('\\resumeProjectHeading{\\github{https://github.com/a/really/long/url/that/never/renders}{\\textbf{Proj}}}{}');
  assert.ok(!withUrl.includes('github.com'), withUrl);
  assert.ok(withUrl.includes('Proj'), withUrl);
});

test('wrapping scales with text length and inversely with width', () => {
  const short = wrappedLines('a'.repeat(40), 400, 11, 0.46);
  const long = wrappedLines('a'.repeat(400), 400, 11, 0.46);
  assert.strictEqual(short, 1);
  assert.ok(long > short);
  assert.ok(wrappedLines('a'.repeat(400), 200, 11, 0.46) > long, 'narrower measure wraps more');
  assert.strictEqual(wrappedLines('', 400, 11, 0.46), 0);
});

test('commented-out blocks contribute no height', () => {
  const item = '  \\resumeItem{Built a data pipeline that ingests feeds and posts digests.}';
  const shown = estimate(`${PREAMBLE}\\section{Experience}\n${item.repeat(1)}\n`);
  const hidden = estimate(`${PREAMBLE}\\section{Experience}\n% ${item.trim()}\n`);
  assert.ok(shown.estimatedPt > hidden.estimatedPt, 'hiding a block must reduce the estimate');
});

test('height grows monotonically as items are added', () => {
  const item = '  \\resumeItem{Engineered a plugin architecture for swappable providers.}\n';
  let last = 0;
  for (const n of [1, 3, 6, 12]) {
    const { estimatedPt } = estimate(`${PREAMBLE}\\section{Projects}\n${item.repeat(n)}`);
    assert.ok(estimatedPt > last, `n=${n} should exceed the previous estimate`);
    last = estimatedPt;
  }
});

test('verdict moves fits -> over as content piles up', () => {
  const item = '  \\resumeItem{Designed and shipped a service that handles production traffic daily.}\n';
  const small = estimate(`${PREAMBLE}\\section{Experience}\n${item.repeat(2)}`);
  const huge = estimate(`${PREAMBLE}\\section{Experience}\n${item.repeat(120)}`);
  assert.strictEqual(small.verdict, 'fits');
  assert.strictEqual(huge.verdict, 'over');
  assert.ok(huge.pages > 1, `expected multi-page, got ${huge.pages}`);
  assert.ok(huge.overshootPt > 0);
});

test('borderline is reported rather than guessed either way', () => {
  const geo = readGeometry(PREAMBLE);
  const item = '  \\resumeItem{Built a reliable data pipeline for ingesting and enriching feeds.}\n';
  // Walk up until the verdict stops being "fits"; the first non-fit must be
  // borderline, never a jump straight to "over".
  let seenBorderline = false;
  for (let n = 1; n < 200; n++) {
    const r = estimate(`${PREAMBLE}\\section{Experience}\n${item.repeat(n)}`);
    if (r.verdict === 'borderline') { seenBorderline = true; }
    if (r.verdict === 'over') break;
    assert.ok(r.usablePt === Math.round(geo.textHeight));
  }
  assert.ok(seenBorderline, 'there must be a hedged band before declaring overflow');
});

test('per-section heights sum to no more than the whole', () => {
  const r = estimate(FIXTURE);
  const sum = r.sections.reduce((a, s) => a + s.heightPt, 0);
  assert.ok(r.sections.length > 0, 'fixture should yield sections');
  assert.ok(sum <= r.estimatedPt, `sections (${sum}) must not exceed total (${r.estimatedPt})`);
});

// Long enough to wrap. A short item is one line at every width and ratio, so
// it can't demonstrate anything about wrapping.
const LONG_ITEM = '  \\resumeItem{Designed and shipped a distributed ingestion service that handles '
  + 'production traffic across multiple regions, with retries, backpressure, and end-to-end '
  + 'tracing wired through every stage of the pipeline.}\n';

test('a wider measure fits more text in the same height', () => {
  const narrow = estimate(`\\documentclass[letterpaper,11pt]{article}\n\\begin{document}\n${LONG_ITEM.repeat(20)}`);
  const wide = estimate(`\\documentclass[letterpaper,11pt]{article}\n\\addtolength{\\textwidth}{2in}\n\\begin{document}\n${LONG_ITEM.repeat(20)}`);
  assert.ok(wide.estimatedPt < narrow.estimatedPt,
    `wider measure should wrap less: wide=${wide.estimatedPt} narrow=${narrow.estimatedPt}`);
});

test('the char-width ratio is tunable, and wider glyphs never estimate shorter', () => {
  // Line counts are integers, so any single text length may round to the same
  // number of lines at both ratios. The invariant is directional, not strict:
  // wider glyphs must never produce a *shorter* estimate, and across a spread
  // of lengths must sometimes produce a taller one.
  let strictlyTallerSomewhere = false;
  for (let len = 40; len <= 400; len += 20) {
    const item = `  \\resumeItem{${'x'.repeat(len)}}\n`;
    const src = `${PREAMBLE}\\section{Experience}\n${item.repeat(10)}`;
    const tight = estimate(src, '', { charWidthRatio: 0.40 }).estimatedPt;
    const loose = estimate(src, '', { charWidthRatio: 0.55 }).estimatedPt;
    assert.ok(loose >= tight, `len=${len}: wider glyphs estimated shorter (${loose} < ${tight})`);
    if (loose > tight) strictlyTallerSomewhere = true;
  }
  assert.ok(strictlyTallerSomewhere, 'the ratio never changed the estimate — is it being applied?');
});

test('a short item is one line; the wrap threshold is where we think it is', () => {
  const geo = readGeometry(PREAMBLE);
  const perChar = geo.fontSize * 0.9 * 0.46;
  const charsPerLine = Math.floor((geo.textWidth - 30) / perChar);
  // Sanity-check the number that drives every estimate, so a geometry
  // regression shows up here rather than as a silently wrong page count.
  assert.ok(charsPerLine > 60 && charsPerLine < 130,
    `implausible chars-per-line for a resume bullet: ${charsPerLine}`);
  assert.strictEqual(wrappedLines('x'.repeat(charsPerLine), geo.textWidth - 30, geo.fontSize * 0.9, 0.46), 1);
  assert.strictEqual(wrappedLines('x'.repeat(charsPerLine + 1), geo.textWidth - 30, geo.fontSize * 0.9, 0.46), 2);
});
