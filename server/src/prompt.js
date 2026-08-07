/**
 * The prompt, the response schema, and the coercion layer — everything that is
 * the same regardless of which model provider runs the request.
 *
 * The prompt hands the model a pre-parsed *block inventory* rather than raw
 * LaTeX-with-line-numbers. That's deliberate: picking a block id it was handed
 * is a far easier task than counting lines, and wrong ids fail loudly at apply
 * time instead of silently editing the wrong region.
 */

const SYSTEM_PROMPT = `You are a resume optimization assistant. You tailor an existing LaTeX resume to a specific job description.

You will receive:
  1. A job description.
  2. An inventory of addressable blocks in the resume (each has an id, section, title, whether it is currently commented out, and its text).
  3. The full LaTeX source, for context.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "summary": "2-3 sentences on how well this resume currently fits the role.",
  "keywords": ["important terms from the JD that are missing from the resume"],

  // Score EVERY block in the inventory, including ones already commented out.
  // This is the most important part of your reply.
  "rankings": [
    { "blockId": "kafka-event-pipeline", "relevance": 92, "reason": "JD asks for streaming systems" }
  ],

  "suggestions": [
    {
      "id": "s1",
      "type": "reword" | "block_comment" | "block_uncomment" | "block_move",
      "rationale": "One sentence tying this to a specific requirement in the JD.",
      "confidence": "high" | "medium" | "low",

      // reword only — anchor MUST be copied character-for-character from the source:
      "anchor": "exact existing text",
      "replacement": "new text",
      "line": 23,

      // block_comment / block_uncomment / block_move only:
      "blockId": "kafka-event-pipeline",
      "afterBlockId": "backend-engineer"   // block_move only; omit to move to section start
    }
  ]
}

Rules for "rankings":
- Score EVERY block id in the inventory. A block you omit is treated as irrelevant and will be dropped.
- relevance is 0-100: 90+ the JD explicitly asks for this; 70-89 strongly supporting; 40-69 generally useful; 10-39 weak; 0-9 irrelevant to this role.
- Judge relevance to THIS job only. Do not consider length, page count, or ordering — those are handled after you, by code that measures the actual page. Rank a superb but unrelated project low, and rank a hidden block high if the JD calls for it.
- Score currently-commented blocks on the same scale as visible ones. Being hidden today says nothing about relevance to this job.

Rules for "suggestions" (rewording only):
- "anchor" must be an exact substring of the source, long enough to be unique. Never paraphrase it. If you cannot copy it exactly, omit the suggestion.
- "replacement" must be valid LaTeX using only macros already present in the document. Escape %, &, _, # as \\%, \\&, \\_, \\#.
- Never invent experience, employers, dates, metrics, or technologies the candidate does not already claim. You may sharpen weak phrasing ("worked on" -> "built"), surface a concrete detail already implied by the text, and re-emphasize existing work toward the JD. You may NOT fabricate numbers.
- Prefer 5-12 high-value rewords over an exhaustive list. Order them most impactful first.
- Do NOT emit block_comment, block_uncomment, or block_move. Which blocks appear, and in what order, is decided from your rankings by code that measures the page.`;

const SUGGESTION_TYPES = ['reword', 'block_comment', 'block_uncomment', 'block_move'];

/**
 * Base JSON Schema for the reply. Providers that support schema-constrained
 * decoding get this (adapted to their dialect); the rest fall back to
 * extractJson + normalize, which every provider goes through anyway.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          blockId: { type: 'string' },
          relevance: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['blockId', 'relevance'],
        additionalProperties: false,
      },
    },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: SUGGESTION_TYPES },
          rationale: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          anchor: { type: 'string' },
          replacement: { type: 'string' },
          blockId: { type: 'string' },
          afterBlockId: { type: 'string' },
        },
        required: ['id', 'type', 'rationale', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'keywords', 'rankings', 'suggestions'],
  additionalProperties: false,
};

/**
 * OpenAI's strict mode requires every property to appear in `required`, so
 * genuinely optional fields have to be expressed as nullable instead.
 */
function strictSchema() {
  const clone = JSON.parse(JSON.stringify(RESPONSE_SCHEMA));
  const item = clone.properties.suggestions.items;
  for (const key of ['anchor', 'replacement', 'blockId', 'afterBlockId']) {
    item.properties[key] = { type: ['string', 'null'] };
  }
  item.required = Object.keys(item.properties);
  return clone;
}

function buildPrompt({ jobDescription, doc, source, filename }) {
  const inventory = doc.blocks.map((b) => ({
    id: b.id,
    section: b.section,
    title: b.title,
    commented: b.commented,
    lines: [b.startLine, b.endLine],
    text: b.text.length > 900 ? `${b.text.slice(0, 900)}\n…(truncated)` : b.text,
  }));

  return [
    '## Job description',
    jobDescription.trim(),
    '',
    `## Block inventory for ${filename} (${doc.blocks.length} blocks)`,
    JSON.stringify(inventory, null, 1),
    '',
    '## Full LaTeX source',
    '```latex',
    source,
    '```',
    '',
    'Produce the JSON object now.',
  ].join('\n');
}

/** Pull a JSON object out of a reply that may be fenced or prefixed with prose. */
function extractJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('The model returned an empty response.');

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch { /* fall through to brace scan */ }

  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('The model returned no JSON object.');
  let depth = 0;
  let inString = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('The model returned a truncated JSON object.');
}

/** Normalize and validate what the model returned, dropping anything unusable. */
function normalize(raw) {
  const out = {
    summary: raw.summary || '',
    keywords: raw.keywords || [],
    ranking: {},
    reasons: {},
    suggestions: [],
    rejected: [],
  };

  for (const r of raw.rankings || []) {
    if (!r || typeof r.blockId !== 'string') continue;
    const score = Number(r.relevance);
    if (!Number.isFinite(score)) continue;
    out.ranking[r.blockId] = Math.max(0, Math.min(100, score));
    if (r.reason) out.reasons[r.blockId] = r.reason;
  }

  (raw.suggestions || []).forEach((s, i) => {
    const id = s.id || `s${i + 1}`;
    if (!SUGGESTION_TYPES.includes(s.type)) {
      out.rejected.push({ id, reason: `unknown type "${s.type}"` });
      return;
    }
    if (s.type === 'reword') {
      if (!s.anchor || !('replacement' in s) || s.replacement === null) {
        out.rejected.push({ id, reason: 'reword missing anchor or replacement' });
        return;
      }
    } else if (!s.blockId) {
      out.rejected.push({ id, reason: `${s.type} missing blockId` });
      return;
    }
    // Strict-mode providers fill unused fields with null; drop them so the
    // applier's "is this field present" checks stay meaningful.
    const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null));
    out.suggestions.push({ ...clean, id });
  });

  return out;
}

module.exports = {
  SYSTEM_PROMPT,
  SUGGESTION_TYPES,
  RESPONSE_SCHEMA,
  strictSchema,
  buildPrompt,
  extractJson,
  normalize,
};
