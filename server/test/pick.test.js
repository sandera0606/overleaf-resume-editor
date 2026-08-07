const assert = require('node:assert');
const { test } = require('node:test');
const { pickSource, isOutput } = require('../src/pick');

const f = (name, blocks = 5) => ({ name, blocks });

test('master.tex at the root wins outright', () => {
  const { suggested, reason } = pickSource([f('main.tex', 20), f('master.tex', 1), f('cv.tex', 30)]);
  assert.strictEqual(suggested, 'master.tex');
  assert.strictEqual(reason, 'convention');
});

test("Jake's main.tex is used when there is no master.tex", () => {
  const { suggested, reason } = pickSource([f('main.tex', 7)]);
  assert.strictEqual(suggested, 'main.tex');
  assert.strictEqual(reason, 'known-name');
});

test('an unconventionally named resume still works', () => {
  const { suggested, reason } = pickSource([f('sandra_resume_v3.tex', 12)]);
  assert.strictEqual(suggested, 'sandra_resume_v3.tex');
  assert.strictEqual(reason, 'most-blocks');
});

test('between unknown names, the one with more blocks wins', () => {
  const { suggested } = pickSource([f('notes.tex', 1), f('resume_final.tex', 22)]);
  assert.strictEqual(suggested, 'resume_final.tex');
});

test('generated versions are never suggested', () => {
  const { suggested, candidates } = pickSource([
    f('versions/acme.tex', 40),
    f('versions/tesla/design.tex', 38),
    f('master.tex', 3),
  ]);
  assert.strictEqual(suggested, 'master.tex');
  assert.ok(!candidates.some((c) => c.name.startsWith('versions/')),
    'output files must not even be offered as candidates');
});

test('a project that is nothing but generated versions suggests nothing', () => {
  const { suggested, reason } = pickSource([f('versions/acme.tex', 40), f('versions/globex.tex', 40)]);
  assert.strictEqual(suggested, null);
  assert.strictEqual(reason, 'no-tex');
});

test('non-tex files are ignored', () => {
  const { suggested, candidates } = pickSource([f('styles/resume-style.sty', 9), f('main.tex', 4)]);
  assert.strictEqual(suggested, 'main.tex');
  assert.strictEqual(candidates.length, 1);
});

test('a root file beats a nested one of equal standing', () => {
  const { suggested } = pickSource([f('src/resume.tex', 10), f('resume.tex', 10)]);
  assert.strictEqual(suggested, 'resume.tex');
});

test('a block-free root file is still offered, just ranked last', () => {
  const { suggested, candidates } = pickSource([f('preamble.tex', 0), f('whatever.tex', 2)]);
  assert.strictEqual(suggested, 'whatever.tex');
  assert.strictEqual(candidates.length, 2, 'both remain selectable');
});

test('every candidate is returned so the picker can offer them', () => {
  const { candidates } = pickSource([f('master.tex', 5), f('main.tex', 5), f('extra.tex', 5)]);
  assert.deepStrictEqual(candidates.map((c) => c.name), ['master.tex', 'main.tex', 'extra.tex']);
});

test('the empty project is handled', () => {
  assert.deepStrictEqual(pickSource([]), { suggested: null, candidates: [], reason: 'no-tex' });
  assert.strictEqual(pickSource().suggested, null);
});

test('isOutput recognises the versions folder at any depth', () => {
  assert.strictEqual(isOutput('versions/a.tex'), true);
  assert.strictEqual(isOutput('versions/tesla/design.tex'), true);
  assert.strictEqual(isOutput('master.tex'), false);
  assert.strictEqual(isOutput('my-versions-notes.tex'), false, 'prefix match must not over-reach');
});

test('ordering is stable and deterministic', () => {
  const files = [f('b.tex', 3), f('a.tex', 3), f('master.tex', 1)];
  const once = pickSource(files).candidates.map((c) => c.name);
  const twice = pickSource(files.slice().reverse()).candidates.map((c) => c.name);
  assert.deepStrictEqual(once, twice, 'input order must not change the result');
});
