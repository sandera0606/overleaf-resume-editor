/**
 * LaTeX resume parsing and editing.
 *
 * The goal here is to turn a resume .tex into a list of *addressable blocks*
 * (one per job / project / bullet group) so Claude can say "comment out block
 * proj-kafka-pipeline" instead of guessing line numbers. Line numbers drift as
 * soon as any edit lands; content-derived ids don't.
 */

const DEFAULT_HEADING_MACROS = [
  'resumeSubheading',
  'resumeProjectHeading',
  'resumeSubItem',
  'cventry',
  'cvitem',
];

/**
 * Lines that close out a *group* of blocks.
 *
 * Deliberately excludes \resumeItemListEnd: that closes the block's own bullet
 * list, so it belongs INSIDE the block. Treating it as a terminator leaves the
 * delimiter dangling when a block is commented out, which breaks the build.
 */
const TERMINATOR_PATTERNS = [
  /^\\resumeSubHeadingListEnd\b/,
  /^\\end\{itemize\}/,
  /^\\end\{document\}/,
  /^\\section\b/,
];

const SENTINEL_START = /^%+\s*>>>\s*BLOCK:\s*(.+?)\s*$/;
const SENTINEL_END = /^%+\s*<<<\s*END\b/;

/** Strip leading whitespace and an optional LaTeX comment marker. */
function decompose(line) {
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const rest = line.slice(indent.length);
  const commentMatch = rest.match(/^(%+)\s?/);
  if (commentMatch) {
    return { indent, commented: true, marker: commentMatch[0], body: rest.slice(commentMatch[0].length) };
  }
  return { indent, commented: false, marker: '', body: rest };
}

function isBlank(line) {
  return line.trim() === '';
}

/** Read a balanced {...} group starting at or after `from`. Returns its inner text. */
function readBraceGroup(str, from = 0) {
  const open = str.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; } // skip escaped char
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { text: str.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Flatten LaTeX markup to readable text, keeping macro arguments. */
function texToPlain(s) {
  let out = s;
  for (let i = 0; i < 5; i++) {
    out = out.replace(/\\[a-zA-Z]+\*?\s*\{([^{}]*)\}/g, '$1');
  }
  return out
    .replace(/\$\s*\|\s*\$/g, '|')
    .replace(/[${}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull a block's title out of its heading macro.
 *
 * Templates like Jake's put the macro on one line and its arguments on the
 * next, so we accumulate lines until the first brace group balances.
 */
function extractTitle(marks, i, lookahead = 6) {
  let buf = '';
  for (let j = i; j < Math.min(i + lookahead, marks.length); j++) {
    buf += (j > i ? ' ' : '') + marks[j].body;
    const g = readBraceGroup(buf);
    if (g) {
      const plain = texToPlain(g.text);
      if (plain) return plain;
    }
  }
  return null;
}

function slugify(text) {
  return text
    .replace(/\\[a-zA-Z]+\s*/g, ' ')      // drop macros
    .replace(/[{}$\\]/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'block';
}

/**
 * Parse a .tex document into sections and blocks.
 *
 * A block spans from a heading macro (or `% >>> BLOCK:` sentinel) up to just
 * before the next heading, terminator, or section — trailing blanks trimmed.
 * A block counts as commented-out only if every non-blank line in it is
 * commented, which is what lets us round-trip comment/uncomment safely.
 */
function parse(source, options = {}) {
  const headingMacros = options.headingMacros || DEFAULT_HEADING_MACROS;
  const headingRe = new RegExp(`^\\\\(${headingMacros.join('|')})\\b`);
  const lines = source.split('\n');

  const marks = lines.map((line, i) => {
    const d = decompose(line);
    return {
      index: i,
      raw: line,
      ...d,
      blank: isBlank(line),
      isHeading: headingRe.test(d.body),
      isSection: /^\\section\b/.test(d.body),
      isTerminator: TERMINATOR_PATTERNS.some((re) => re.test(d.body)),
      sentinelStart: line.match(SENTINEL_START),
      sentinelEnd: SENTINEL_END.test(line),
    };
  });

  const sections = [{ name: 'Preamble', startLine: 1, endLine: lines.length, blocks: [] }];
  for (const m of marks) {
    if (!m.isSection) continue;
    sections[sections.length - 1].endLine = m.index; // 1-based line before this one
    const g = readBraceGroup(m.body);
    sections.push({
      name: g ? texToPlain(g.text) : `Section at line ${m.index + 1}`,
      startLine: m.index + 1,
      endLine: lines.length,
      blocks: [],
    });
  }

  // lineIndex is 0-based; section.startLine is 1-based.
  const sectionFor = (lineIndex) => {
    let best = sections[0];
    for (const s of sections) if (s.startLine - 1 <= lineIndex) best = s;
    return best;
  };

  const blocks = [];
  const seenIds = new Map();

  const pushBlock = (start, end, title, kind) => {
    // Trim trailing blank lines off the block.
    while (end > start && marks[end].blank) end--;
    const body = marks.slice(start, end + 1);
    const meaningful = body.filter((m) => !m.blank);
    if (!meaningful.length) return;

    const baseId = slugify(title);
    const n = (seenIds.get(baseId) || 0) + 1;
    seenIds.set(baseId, n);
    const id = n === 1 ? baseId : `${baseId}-${n}`;

    const section = sectionFor(start);
    const block = {
      id,
      title,
      kind,
      section: section.name,
      startLine: start + 1,          // 1-based, inclusive — matches editor gutters
      endLine: end + 1,
      commented: meaningful.every((m) => m.commented),
      text: lines.slice(start, end + 1).join('\n'),
    };
    blocks.push(block);
    section.blocks.push(id);
  };

  // Sentinel-delimited blocks take priority — they're the user's explicit escape
  // hatch for templates our macro list doesn't recognise.
  const consumed = new Set();
  for (let i = 0; i < marks.length; i++) {
    const s = marks[i].sentinelStart;
    if (!s) continue;
    let end = i;
    for (let j = i + 1; j < marks.length; j++) {
      if (marks[j].sentinelEnd) { end = j; break; }
    }
    if (end === i) continue; // unterminated sentinel — ignore
    pushBlock(i, end, s[1], 'sentinel');
    for (let k = i; k <= end; k++) consumed.add(k);
    i = end;
  }

  for (let i = 0; i < marks.length; i++) {
    if (consumed.has(i) || !marks[i].isHeading) continue;
    const title = extractTitle(marks, i) || `Block at line ${i + 1}`;

    let end = marks.length - 1;
    for (let j = i + 1; j < marks.length; j++) {
      if (consumed.has(j)) { end = j - 1; break; }
      if (marks[j].isHeading || marks[j].isSection || marks[j].isTerminator) { end = j - 1; break; }
    }
    pushBlock(i, end, title, 'heading');
    for (let k = i; k <= end; k++) consumed.add(k);
    i = end;
  }

  blocks.sort((a, b) => a.startLine - b.startLine);
  for (const b of blocks) {
    const s = sections.find((x) => x.name === b.section);
    if (s) s.blocks.push(b.id);
  }

  return { lines, sections, blocks };
}

/**
 * Comment out a run of lines, aligning every marker at the block's shallowest
 * indent so the region reads as one commented unit and round-trips exactly.
 */
function commentLines(lines, marker = '% ') {
  const indents = lines
    .filter((l) => !isBlank(l))
    .map((l) => decompose(l).indent.length);
  const base = indents.length ? Math.min(...indents) : 0;

  return lines.map((line) => {
    if (isBlank(line)) return line;
    if (decompose(line).commented) return line;
    return `${' '.repeat(base)}${marker}${line.slice(base)}`;
  });
}

function uncommentLines(lines) {
  return lines.map((line) => {
    if (isBlank(line)) return line;
    const d = decompose(line);
    if (!d.commented) return line;
    return `${d.indent}${d.body}`;
  });
}

module.exports = {
  parse,
  commentLines,
  uncommentLines,
  slugify,
  readBraceGroup,
  DEFAULT_HEADING_MACROS,
};
