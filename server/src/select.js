/**
 * Turn a relevance ranking into a one-page resume.
 *
 * The division of labour: the model decides what is *relevant*, this file
 * decides what *fits* and in what order. Arithmetic is not a judgment call, and
 * asking a model to reason about page height was the weakest instruction in the
 * old prompt ("if you uncomment N blocks, comment out a comparable amount").
 *
 * Ordering follows résumé convention rather than raw relevance:
 *
 *   - Sections whose blocks carry dates (Experience, Research, Education) stay
 *     reverse-chronological. Recruiters read progression and gaps from date
 *     order, so shuffling them by relevance reads as a mistake at best.
 *   - Sections without dates (Projects, Skills, Awards) are ordered
 *     most-relevant-first, where there is no convention to violate.
 *
 * Which sections are dated is detected from the source, not assumed from names,
 * so a template that dates its projects gets chronological projects.
 */

const { measure, readGeometry, PT_PER_INCH } = require('./layout');

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Pull the latest date out of a block, as a sortable month index.
 * "May 2026 -- Aug 2026" sorts on Aug 2026; an ongoing role ("Jan 2026 --
 * Present") sorts above every finished one, which is the convention.
 */
function parseDate(text) {
  if (!text) return null;
  if (/\bpresent\b|\bcurrent\b|\bongoing\b/i.test(text)) return Number.MAX_SAFE_INTEGER;

  let best = null;
  const re = /\b([A-Za-z]{3,9})\.?\s+(\d{4})\b/g;
  for (const m of text.matchAll(re)) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!month) continue;
    const value = Number(m[2]) * 12 + month;
    if (best === null || value > best) best = value;
  }
  if (best !== null) return best;

  // Year alone still orders correctly against other year-only blocks.
  for (const m of text.matchAll(/\b(19|20)(\d{2})\b/g)) {
    const value = Number(`${m[1]}${m[2]}`) * 12 + 12;
    if (best === null || value > best) best = value;
  }
  return best;
}

/**
 * Does this block carry an unambiguous date — a month paired with a year, or an
 * explicit "Present"?
 *
 * Classification deliberately ignores the bare-year fallback that `parseDate`
 * accepts. A project blurb mentioning "Python 3000 requests" or a bare "2021"
 * in prose would otherwise flip an undated Projects section into chronological
 * ordering, which is precisely the mistake this whole heuristic exists to
 * avoid. Bare years are still good enough to *sort* blocks already known to be
 * dated; they are not good enough to decide that a section is dated at all.
 */
function hasExplicitDate(text) {
  if (!text) return false;
  if (/\bpresent\b|\bcurrent\b|\bongoing\b/i.test(text)) return true;
  return /\b([A-Za-z]{3,9})\.?\s+(19|20)\d{2}\b/.test(text)
    && MONTHS[(text.match(/\b([A-Za-z]{3,9})\.?\s+(?:19|20)\d{2}\b/) || [])[1]?.slice(0, 3).toLowerCase()] !== undefined;
}

/**
 * A section is "dated" when most of its blocks carry an explicit date.
 * The threshold tolerates one undated straggler without flipping a whole
 * Experience section into relevance order.
 */
function sectionIsDated(blocks) {
  if (!blocks.length) return false;
  const dated = blocks.filter((b) => hasExplicitDate(b.text)).length;
  return dated / blocks.length >= 0.6;
}

/**
 * Choose blocks to show, highest relevance first, until the page budget runs
 * out; then order what survived per the convention above.
 *
 * @param {object} doc        parsed document (from latex.js)
 * @param {object} ranking    { blockId: relevance 0-100 }
 * @param {object} [opts]     { source, sty, charWidthRatio, budgetPt, keepSections }
 * @returns {{show, hide, order, estimate, sections, dropped}}
 */
function selectToFit(doc, ranking = {}, opts = {}) {
  const source = opts.source || '';
  const geo = readGeometry(source, opts.sty || '');
  const measureOpts = { charWidthRatio: opts.charWidthRatio };

  // Everything that is not a block — section headings, preamble, the contact
  // header — is unavoidable overhead and comes off the budget first.
  const blockLines = new Set();
  for (const b of doc.blocks) {
    for (let n = b.startLine; n <= b.endLine; n++) blockLines.add(n);
  }
  const chrome = source.split('\n').filter((_, i) => !blockLines.has(i + 1)).join('\n');
  const overhead = measure(chrome, geo, measureOpts).height + geo.baseline * 3;

  const budget = opts.budgetPt || geo.textHeight;
  let remaining = budget - overhead;

  const scored = doc.blocks.map((b) => ({
    block: b,
    relevance: Number(ranking[b.id] ?? 0),
    // Cost the block as if shown, whether or not it currently is.
    heightPt: measure(uncomment(b.text), geo, measureOpts).height,
    date: parseDate(b.text),
  }));

  // Greedy fill by relevance. Ties break toward the shorter block, which fits
  // strictly more content at equal relevance.
  const byRelevance = scored.slice().sort((a, b) =>
    b.relevance - a.relevance || a.heightPt - b.heightPt);

  const show = [];
  const dropped = [];
  for (const entry of byRelevance) {
    if (entry.heightPt <= remaining) {
      show.push(entry);
      remaining -= entry.heightPt;
    } else {
      dropped.push({ id: entry.block.id, relevance: entry.relevance, heightPt: Math.round(entry.heightPt) });
    }
  }

  // Order within each section.
  const sections = [];
  const bySection = new Map();
  for (const entry of show) {
    const name = entry.block.section || '';
    if (!bySection.has(name)) bySection.set(name, []);
    bySection.get(name).push(entry);
  }

  const order = [];
  for (const [name, entries] of bySection) {
    const dated = sectionIsDated(entries.map((e) => e.block));
    entries.sort(dated
      // Newest first; an undated straggler sinks rather than jumping the queue.
      ? (a, b) => (b.date ?? -1) - (a.date ?? -1)
      : (a, b) => b.relevance - a.relevance);
    sections.push({
      name,
      ordering: dated ? 'chronological' : 'relevance',
      blocks: entries.map((e) => e.block.id),
    });
    order.push(...entries.map((e) => e.block.id));
  }

  // Section headings have to follow their contents.
  //
  // A master resume typically keeps whole sections commented out (Research,
  // Awards) alongside their blocks. Un-hiding a block without un-hiding its
  // heading renders that item under the *previous* section — silently wrong in
  // a way the block-level tests can't see. The reverse matters too: a section
  // whose every block was dropped must not leave a bare heading behind.
  // Scanned from the source rather than doc.sections: a fully commented-out
  // section may not be parsed as a section at all, and those are exactly the
  // ones that need un-hiding when a block inside them is selected.
  const selectedSections = new Set(sections.map((s) => s.name));
  const showSections = [];
  const hideSections = [];

  source.split('\n').forEach((line, i) => {
    const m = line.match(/^(\s*)(%\s*)?\\section\{([^}]*)\}/);
    if (!m) return;
    const name = m[3];
    const hiddenNow = Boolean(m[2]);
    const wanted = selectedSections.has(name);
    if (wanted && hiddenNow) showSections.push({ name, line: i + 1 });
    if (!wanted && !hiddenNow) hideSections.push({ name, line: i + 1 });
  });

  const usedPt = budget - remaining;
  return {
    show: show.map((e) => e.block.id),
    hide: dropped.map((d) => d.id),
    order,
    sections,
    showSections,
    hideSections,
    dropped,
    estimate: {
      overheadPt: Math.round(overhead),
      usedPt: Math.round(usedPt),
      budgetPt: Math.round(budget),
      usedIn: +(usedPt / PT_PER_INCH).toFixed(2),
      budgetIn: +(budget / PT_PER_INCH).toFixed(2),
      fillRatio: +(usedPt / budget).toFixed(3),
      shown: show.length,
      hidden: dropped.length,
    },
  };
}

/**
 * Express a plan as ordinary suggestions, so it flows through the same tested
 * applier as everything else rather than growing a second edit path.
 *
 * Moves are emitted as a chain (`b after a`, `c after b`) so each block's
 * anchor is one that has already been placed. Emitting them against original
 * positions would fight the re-parse that `applyMoves` does between operations.
 */
function planToSuggestions(doc, plan) {
  const byId = new Map(doc.blocks.map((b) => [b.id, b]));
  const out = [];
  let n = 0;
  const id = (kind) => `plan-${kind}-${++n}`;

  for (const blockId of plan.hide) {
    const b = byId.get(blockId);
    if (b && !b.commented) {
      out.push({ id: id('hide'), type: 'block_comment', blockId, rationale: 'Did not fit the page budget.' });
    }
  }
  for (const blockId of plan.show) {
    const b = byId.get(blockId);
    if (b && b.commented) {
      out.push({ id: id('show'), type: 'block_uncomment', blockId, rationale: 'Relevant to this job.' });
    }
  }

  for (const section of plan.sections) {
    const current = doc.blocks.filter((b) => b.section === section.name && section.blocks.includes(b.id));
    const already = current.map((b) => b.id);
    // Only emit moves when the wanted order actually differs from the current one.
    if (already.join('|') === section.blocks.join('|')) continue;
    let previous = null;
    for (const blockId of section.blocks) {
      out.push({
        id: id('move'),
        type: 'block_move',
        blockId,
        afterBlockId: previous || undefined,
        rationale: section.ordering === 'chronological' ? 'Newest first.' : 'Most relevant first.',
      });
      previous = blockId;
    }
  }

  return out;
}

/** Strip leading comment markers so a hidden block is costed at its shown size. */
function uncomment(text) {
  return text.split('\n').map((l) => l.replace(/^(\s*)%\s?/, '$1')).join('\n');
}

module.exports = { selectToFit, planToSuggestions, parseDate, hasExplicitDate, sectionIsDated, uncomment };
