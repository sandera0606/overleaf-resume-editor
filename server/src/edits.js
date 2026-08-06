/**
 * Applies accepted suggestions to a .tex source.
 *
 * Two rules make this safe:
 *   1. Rewords are anchored to exact original text, never to line numbers.
 *      If the anchor isn't found, the suggestion fails loudly instead of
 *      writing to a guessed location.
 *   2. Structural edits run in phases, re-parsing between each, so block ids
 *      and line ranges are always computed against the current text.
 */

const { parse, commentLines, uncommentLines } = require('./latex');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whitespace-tolerant search: collapses runs of spaces/newlines when matching. */
function findOccurrences(text, anchor) {
  const exact = [];
  let idx = text.indexOf(anchor);
  while (idx !== -1) {
    exact.push(idx);
    idx = text.indexOf(anchor, idx + 1);
  }
  if (exact.length) return { mode: 'exact', offsets: exact, length: anchor.length };

  const loose = new RegExp(
    escapeRe(anchor.trim()).replace(/(\\?\s)+/g, '\\s+'),
    'g',
  );
  const hits = [];
  let m;
  while ((m = loose.exec(text)) !== null) {
    hits.push({ offset: m.index, length: m[0].length });
    if (m.index === loose.lastIndex) loose.lastIndex++;
  }
  if (hits.length) return { mode: 'loose', offsets: hits.map((h) => h.offset), lengths: hits.map((h) => h.length) };

  return { mode: 'none', offsets: [] };
}

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function applyRewords(text, suggestions, results) {
  let out = text;
  for (const s of suggestions) {
    const found = findOccurrences(out, s.anchor);
    if (found.mode === 'none') {
      results.push({ id: s.id, status: 'failed', reason: 'Original text not found — the file may have changed since analysis.' });
      continue;
    }

    let pick = 0;
    if (found.offsets.length > 1) {
      if (typeof s.line !== 'number') {
        results.push({ id: s.id, status: 'failed', reason: `Ambiguous: "${s.anchor.slice(0, 40)}…" appears ${found.offsets.length} times and no line hint was given.` });
        continue;
      }
      let best = Infinity;
      found.offsets.forEach((off, i) => {
        const d = Math.abs(lineOf(out, off) - s.line);
        if (d < best) { best = d; pick = i; }
      });
    }

    const offset = found.offsets[pick];
    const length = found.mode === 'loose' ? found.lengths[pick] : found.length;
    out = out.slice(0, offset) + s.replacement + out.slice(offset + length);
    results.push({ id: s.id, status: 'applied', at: lineOf(out, offset), matched: found.mode });
  }
  return out;
}

function resolveBlock(doc, s, results) {
  const block = doc.blocks.find((b) => b.id === s.blockId);
  if (block) return block;
  results.push({ id: s.id, status: 'failed', reason: `Block "${s.blockId}" no longer exists (an earlier edit may have renamed its heading).` });
  return null;
}

function applyBlockToggles(text, suggestions, results) {
  const doc = parse(text);
  const ops = [];

  for (const s of suggestions) {
    const block = resolveBlock(doc, s, results);
    if (!block) continue;

    const wantCommented = s.type === 'block_comment';
    if (block.commented === wantCommented) {
      results.push({ id: s.id, status: 'skipped', reason: `Already ${wantCommented ? 'commented out' : 'active'}.` });
      continue;
    }
    const slice = doc.lines.slice(block.startLine - 1, block.endLine);
    ops.push({
      start: block.startLine - 1,
      end: block.endLine,
      lines: wantCommented ? commentLines(slice) : uncommentLines(slice),
    });
    results.push({ id: s.id, status: 'applied', block: block.id, lines: [block.startLine, block.endLine] });
  }

  // Reverse order so earlier edits don't shift the ranges of later ones.
  ops.sort((a, b) => b.start - a.start);
  const lines = doc.lines.slice();
  for (const op of ops) lines.splice(op.start, op.end - op.start, ...op.lines);
  return lines.join('\n');
}

function applyMoves(text, suggestions, results) {
  let lines = text.split('\n');

  for (const s of suggestions) {
    const doc = parse(lines.join('\n'));
    const block = resolveBlock(doc, s, results);
    if (!block) continue;

    const anchorBlock = doc.blocks.find((b) => b.id === s.afterBlockId);
    if (!anchorBlock && s.afterBlockId) {
      results.push({ id: s.id, status: 'failed', reason: `Anchor block "${s.afterBlockId}" not found.` });
      continue;
    }
    if (anchorBlock && anchorBlock.id === block.id) {
      results.push({ id: s.id, status: 'skipped', reason: 'Block is already in that position.' });
      continue;
    }

    const slice = lines.slice(block.startLine - 1, block.endLine);
    lines.splice(block.startLine - 1, slice.length);

    // Recompute the insertion point against the post-removal text.
    const after = parse(lines.join('\n'));
    let insertAt;
    if (anchorBlock) {
      const target = after.blocks.find((b) => b.id === s.afterBlockId);
      if (!target) {
        results.push({ id: s.id, status: 'failed', reason: `Anchor block "${s.afterBlockId}" vanished mid-move; skipped to avoid corrupting the file.` });
        lines.splice(block.startLine - 1, 0, ...slice); // put it back
        continue;
      }
      insertAt = target.endLine;
    } else {
      const sec = after.sections.find((x) => x.name === block.section);
      insertAt = sec ? sec.startLine + 1 : 0;
    }
    lines.splice(insertAt, 0, ...slice);
    results.push({ id: s.id, status: 'applied', block: block.id, movedAfter: s.afterBlockId || '(section start)' });
  }

  return lines.join('\n');
}

/**
 * @param {string} source original .tex
 * @param {Array} suggestions accepted suggestions only
 * @returns {{text: string, results: Array}}
 */
function applySuggestions(source, suggestions) {
  const results = [];
  const by = (t) => suggestions.filter((s) => s.type === t);

  let text = applyRewords(source, by('reword'), results);
  text = applyBlockToggles(text, [...by('block_comment'), ...by('block_uncomment')], results);
  text = applyMoves(text, by('block_move'), results);

  const unknown = suggestions.filter(
    (s) => !['reword', 'block_comment', 'block_uncomment', 'block_move'].includes(s.type),
  );
  for (const s of unknown) {
    results.push({ id: s.id, status: 'failed', reason: `Unknown suggestion type "${s.type}".` });
  }

  return { text, results };
}

module.exports = { applySuggestions, findOccurrences };
