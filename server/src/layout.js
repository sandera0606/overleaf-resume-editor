/**
 * Estimate how tall a resume will typeset, to warn before it spills onto a
 * second page.
 *
 * This is an ESTIMATE and says so everywhere it surfaces. Only TeX knows where
 * lines actually break; reproducing that means reproducing its line-breaking
 * algorithm and font metrics, and would still be wrong at the boundary — which
 * is exactly where "does it fit" gets decided. Overleaf can't help either: its
 * compile endpoint only ever builds the project's root document, so the
 * generated file can't be measured without mutating project settings.
 *
 * So the contract is deliberately weak: flag a likely overflow and name the
 * blocks worth cutting. Never silently trim, never claim certainty.
 *
 * Everything below is derived from the document's own preamble where possible
 * (\documentclass options, \addtolength, \vspace in the style file) and falls
 * back to stock LaTeX defaults otherwise.
 */

const PT_PER_INCH = 72.27;

// Stock `article` geometry on US Letter, by base font size.
const CLASS_DEFAULTS = {
  10: { textWidth: 345, textHeight: 550, baseline: 12.0 },
  11: { textWidth: 360, textHeight: 550, baseline: 13.6 },
  12: { textWidth: 390, textHeight: 550, baseline: 14.5 },
};

// Average glyph advance as a fraction of font size. Computer Modern's lowercase
// average sits near half an em; this is the single biggest source of error, so
// it is exposed for calibration rather than buried.
const DEFAULT_CHAR_WIDTH_RATIO = 0.46;

// \small inside the item macros of Jake-style templates.
const SMALL_RATIO = 0.9;

/** Convert a LaTeX dimension ("1in", "-0.5in", "13.6pt", "2em") to points. */
function toPt(value, fontSize = 11) {
  const m = String(value).trim().match(/^(-?[\d.]+)\s*(pt|in|cm|mm|em|ex|px)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'in': return n * PT_PER_INCH;
    case 'cm': return n * (PT_PER_INCH / 2.54);
    case 'mm': return n * (PT_PER_INCH / 25.4);
    case 'em': return n * fontSize;
    case 'ex': return n * fontSize * 0.45;
    case 'px': return n * 0.75;
    default: return n; // bare number or explicit pt
  }
}

/** Read page geometry out of the preamble plus any style file. */
function readGeometry(tex, sty = '') {
  const all = `${tex}\n${sty}`;
  const sizeMatch = tex.match(/\\documentclass\[([^\]]*)\]/);
  const fontSize = Number((sizeMatch?.[1].match(/(\d+)pt/) || [])[1]) || 11;
  const base = CLASS_DEFAULTS[fontSize] || CLASS_DEFAULTS[11];

  let { textWidth, textHeight } = base;
  for (const m of all.matchAll(/\\addtolength\{\\(textwidth|textheight)\}\{([^}]*)\}/g)) {
    const delta = toPt(m[2], fontSize);
    if (m[1] === 'textwidth') textWidth += delta;
    else textHeight += delta;
  }
  // An explicit \setlength wins over the accumulated default.
  for (const m of all.matchAll(/\\setlength\{\\(textwidth|textheight)\}\{([^}]*)\}/g)) {
    const v = toPt(m[2], fontSize);
    if (m[1] === 'textwidth') textWidth = v;
    else textHeight = v;
  }

  return { fontSize, textWidth, textHeight, baseline: base.baseline };
}

/**
 * Strip LaTeX down to the text a reader actually sees, so character counts
 * reflect rendered width rather than markup.
 */
function visibleText(latex) {
  let s = latex;
  s = s.replace(/\\(?:textbf|textit|texttt|emph|small|underline|href)\s*/g, ' ');
  // \github{url}{Label} and friends: the URL is a link target, not visible width.
  s = s.replace(/\\(?:github|link|linkedin|email|phone|scholar|video)\{[^}]*\}/g, '');
  s = s.replace(/\\[a-zA-Z@]+\s*(\[[^\]]*\])?/g, ' '); // remaining control sequences
  s = s.replace(/[{}$&~^_\\]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/** How many wrapped lines this text needs at the given width. */
function wrappedLines(text, widthPt, fontSize, charRatio) {
  if (!text) return 0;
  const perChar = fontSize * charRatio;
  const perLine = Math.max(1, Math.floor(widthPt / perChar));
  return Math.max(1, Math.ceil(text.length / perLine));
}

/**
 * Estimate the typeset height of a document.
 *
 * @param {string} tex     the resume source
 * @param {string} sty     the style file, if available (improves geometry)
 * @param {object} [opts]  { charWidthRatio }
 */
function estimate(tex, sty = '', opts = {}) {
  const geo = readGeometry(tex, sty);
  const body = measure(tex, geo, opts);

  // Contact header at the top of the document.
  const height = body.height + geo.baseline * 3;
  const usable = geo.textHeight;
  const pages = Math.max(1, Math.ceil(height / usable));

  return {
    estimatedPt: Math.round(height),
    usablePt: Math.round(usable),
    estimatedIn: +(height / PT_PER_INCH).toFixed(2),
    usableIn: +(usable / PT_PER_INCH).toFixed(2),
    fillRatio: +(height / usable).toFixed(3),
    pages,
    // Deliberately hedged: within a few percent of the limit, the estimate
    // cannot honestly call it either way.
    verdict: height > usable * 1.02 ? 'over' : height > usable * 0.94 ? 'borderline' : 'fits',
    overshootPt: Math.max(0, Math.round(height - usable)),
    geometry: {
      fontSize: geo.fontSize,
      textWidthPt: Math.round(geo.textWidth),
      textHeightPt: Math.round(geo.textHeight),
    },
    sections: body.sections.map((s) => ({ name: s.name, heightPt: Math.round(s.height) })),
  };
}

/**
 * Measure a fragment of LaTeX — a whole document body, or a single block.
 *
 * Costing one block at a time is what makes budget-driven selection possible:
 * blocks can be summed against a page budget without re-measuring the document
 * on every candidate.
 *
 * @returns {{height: number, sections: Array<{name: string, height: number}>}}
 */
function measure(tex, geo, opts = {}) {
  const charRatio = opts.charWidthRatio || DEFAULT_CHAR_WIDTH_RATIO;
  const { textWidth, baseline, fontSize } = geo;

  // Indent inside itemize environments narrows the usable measure.
  const itemIndent = 15;

  let height = 0;
  const sections = [];
  let current = null;

  for (const raw of tex.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%')) continue; // commented-out = not typeset

    const section = line.match(/\\section\{([^}]*)\}/);
    if (section) {
      // Rule + label + surrounding skip.
      height += baseline * 2.2;
      current = { name: section[1], height: 0 };
      sections.push(current);
      continue;
    }

    const isHeading = /\\resume(SubHeading|Subheading|ProjectHeading|SubItem)/.test(line);
    const isItem = /\\resumeItem\b/.test(line);
    if (!isHeading && !isItem) {
      // Structural macros (List starts/ends) carry small fixed skips.
      if (/\\resume\w*List(Start|End)/.test(line)) height += baseline * 0.25;
      continue;
    }

    const text = visibleText(line);
    const width = isItem ? textWidth - itemIndent * 2 : textWidth - itemIndent;
    const size = isItem ? fontSize * SMALL_RATIO : fontSize;
    const lines = wrappedLines(text, width, size, charRatio);
    const block = lines * baseline * (isItem ? SMALL_RATIO : 1) + (isHeading ? baseline * 0.5 : 0);

    height += block;
    if (current) current.height += block;
  }

  return { height, sections };
}

module.exports = {
  estimate, measure, readGeometry, visibleText, wrappedLines, toPt,
  PT_PER_INCH, DEFAULT_CHAR_WIDTH_RATIO,
};
