/**
 * Runs Claude CLI in non-interactive mode and coerces its reply into a
 * suggestion list.
 *
 * The prompt hands Claude a pre-parsed *block inventory* rather than raw
 * LaTeX-with-line-numbers. That's deliberate: picking a block id it was handed
 * is a far easier task than counting lines, and wrong ids fail loudly at apply
 * time instead of silently editing the wrong region.
 */

const { spawn } = require('node:child_process');

const SYSTEM_PROMPT = `You are a resume optimization assistant. You tailor an existing LaTeX resume to a specific job description.

You will receive:
  1. A job description.
  2. An inventory of addressable blocks in the resume (each has an id, section, title, whether it is currently commented out, and its text).
  3. The full LaTeX source, for context.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "summary": "2-3 sentences on how well this resume currently fits the role.",
  "keywords": ["important terms from the JD that are missing from the resume"],
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

Rules:
- "anchor" must be an exact substring of the source, long enough to be unique. Never paraphrase it. If you cannot copy it exactly, omit the suggestion.
- "replacement" must be valid LaTeX using only macros already present in the document. Escape %, &, _, # as \\%, \\&, \\_, \\#.
- Never invent experience, employers, dates, metrics, or technologies the candidate does not already claim. You may sharpen weak phrasing ("worked on" -> "built"), surface a concrete detail already implied by the text, and re-emphasize existing work toward the JD. You may NOT fabricate numbers.
- block_comment hides an irrelevant item; block_uncomment restores a hidden item that fits this JD. Only comment out a block if something better is taking its place or it is clearly irrelevant.
- Resumes are length-constrained. If you uncomment N blocks, comment out a comparable amount.
- Prefer 5-12 high-value suggestions over an exhaustive list. Order them most impactful first.`;

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
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch { /* fall through to brace scan */ }

  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('Claude returned no JSON object.');
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
  throw new Error('Claude returned a truncated JSON object.');
}

function runClaude(prompt, { model, cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--append-system-prompt', SYSTEM_PROMPT];
    if (model) args.push('--model', model);

    // shell:true so Windows resolves the `claude` shim (claude.cmd) on PATH.
    const child = spawn('claude', args, { cwd, shell: process.platform === 'win32' });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not launch Claude CLI: ${err.message}. Is \`claude\` on your PATH?`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Claude CLI exited ${code}: ${stderr.trim() || '(no stderr)'}`));
      }
      try {
        // --output-format json wraps the reply; `result` holds the text.
        const envelope = JSON.parse(stdout);
        resolve({ text: envelope.result ?? stdout, cost: envelope.total_cost_usd, sessionId: envelope.session_id });
      } catch {
        resolve({ text: stdout }); // tolerate a bare-text reply
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Normalize and validate what Claude returned, dropping anything unusable. */
function normalize(raw) {
  const out = { summary: raw.summary || '', keywords: raw.keywords || [], suggestions: [], rejected: [] };
  const valid = ['reword', 'block_comment', 'block_uncomment', 'block_move'];

  (raw.suggestions || []).forEach((s, i) => {
    const id = s.id || `s${i + 1}`;
    if (!valid.includes(s.type)) {
      out.rejected.push({ id, reason: `unknown type "${s.type}"` });
      return;
    }
    if (s.type === 'reword') {
      if (!s.anchor || !('replacement' in s)) {
        out.rejected.push({ id, reason: 'reword missing anchor or replacement' });
        return;
      }
    } else if (!s.blockId) {
      out.rejected.push({ id, reason: `${s.type} missing blockId` });
      return;
    }
    out.suggestions.push({ ...s, id });
  });

  return out;
}

async function analyze({ jobDescription, doc, source, filename, model, cwd }) {
  const prompt = buildPrompt({ jobDescription, doc, source, filename });
  const { text, cost } = await runClaude(prompt, { model, cwd });
  const result = normalize(extractJson(text));
  return { ...result, cost };
}

module.exports = { analyze, buildPrompt, extractJson, normalize, runClaude, SYSTEM_PROMPT };
