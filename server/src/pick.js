/**
 * Decide which .tex in a project is the resume to tailor from.
 *
 * `master.tex` is the convention this tool documents, but most people arrive
 * with Jake's Resume, which ships as `main.tex` — so a project that never
 * adopts the convention still has to work. The ordering below is a preference,
 * not a requirement; the panel always lets you override it.
 *
 * The one hard rule is that generated output is never a candidate. Tailoring
 * from `versions/acme.tex` would compound one job's edits into the next
 * application, quietly narrowing the resume every run.
 */

// Root-level names people actually use for the main document, best first.
const KNOWN_NAMES = ['master.tex', 'main.tex', 'resume.tex', 'cv.tex'];

// Directories that hold this tool's own output, never its input.
const OUTPUT_DIRS = ['versions/'];

const isNested = (name) => name.includes('/');
const dirOf = (name) => (isNested(name) ? `${name.split('/').slice(0, -1).join('/')}/` : '');

/** Generated output, so never a source. */
function isOutput(name) {
  return OUTPUT_DIRS.some((d) => name === d || name.startsWith(d) || dirOf(name).startsWith(d));
}

/**
 * Score a candidate. Higher wins; ties break on block count, then on path
 * length so a root file beats a nested one of equal standing.
 */
function score(file) {
  const name = file.name;
  const base = name.split('/').pop().toLowerCase();
  const known = KNOWN_NAMES.indexOf(base);

  if (!isNested(name) && known === 0) return 1000;             // master.tex at root
  if (!isNested(name) && known > 0) return 900 - known;        // main/resume/cv at root
  if (!isNested(name)) return file.blocks > 0 ? 700 : 300;     // any other root .tex
  if (known === 0) return 600;                                 // master.tex in a subfolder
  return file.blocks > 0 ? 500 : 200;                          // nested, last resort
}

/**
 * @param {Array<{name: string, blocks: number}>} files inventory from /project
 * @returns {{suggested: string|null, candidates: Array, reason: string}}
 */
function pickSource(files = []) {
  const candidates = files
    .filter((f) => /\.tex$/i.test(f.name) && !isOutput(f.name))
    .map((f) => ({ ...f, score: score(f) }))
    .sort((a, b) =>
      b.score - a.score
      || (b.blocks || 0) - (a.blocks || 0)
      || a.name.length - b.name.length
      || a.name.localeCompare(b.name));

  if (!candidates.length) {
    return { suggested: null, candidates: [], reason: 'no-tex' };
  }

  const top = candidates[0];
  const base = top.name.split('/').pop().toLowerCase();
  let reason = 'best-guess';
  if (base === 'master.tex' && !isNested(top.name)) reason = 'convention';
  else if (KNOWN_NAMES.includes(base)) reason = 'known-name';
  else if (top.blocks > 0) reason = 'most-blocks';

  return { suggested: top.name, candidates, reason };
}

module.exports = { pickSource, isOutput, KNOWN_NAMES, OUTPUT_DIRS };
