---
name: tailor-resume
description: Tailor a LaTeX resume to a specific job description — reword bullets, hide irrelevant projects or roles, surface relevant ones that are commented out, and reorder for emphasis. Use when the user pastes a job description and wants their resume adapted to it, asks to optimize/tailor/target a resume at a job, or asks which projects to show or hide for a particular role. Works on local .tex files; the companion Chrome extension covers editing directly in Overleaf.
---

# Tailoring a LaTeX resume to a job description

You do the judgment — which experience matters for this job, how to phrase it. A tested CLI does the mechanics of locating and rewriting blocks.

**Do not hand-edit the .tex.** Commenting out a block by hand reliably orphans its `\resumeItemListEnd`, producing LaTeX that won't compile. The `apply` command handles delimiter balance, indentation, and edit ordering, and is covered by 19 tests. Use it.

## The CLI

`$CLAUDE_PLUGIN_ROOT/server/src/cli.js`, plain Node, no dependencies.

```bash
node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" blocks <file.tex> --json
node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" apply  <file.tex> --suggestions <file.json> [--out <file> | --in-place] [--dry-run]
node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" archive <file.tex> --label "Company — Role" --jd <jd.txt>
node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" list
```

## Workflow

**1. Find the resume.** If the user didn't name one, look for `.tex` files in the working directory and ask which. Don't guess when several exist.

**2. Inventory the blocks.**

```bash
node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" blocks resume.tex --json
```

Returns every addressable block: `id`, `title`, `section`, `commented`, `lines`, `text`. Blocks already commented out are candidates to *restore* — they are usually past projects the user hid for a different application, and often exactly what a new job calls for.

If this returns zero blocks, the template uses macros the parser doesn't know. Tell the user to either add the macro to `headingMacros` in `server/config.json`, or wrap items in `% >>> BLOCK: Name` / `% <<< END` sentinels.

**3. Read the job description.** From a file the user names, or text they paste. Identify the concrete requirements, not the boilerplate.

**4. Write suggestions to a JSON file.** Schema below. Write it to a temp path — never pass LaTeX through shell arguments, quoting will corrupt it.

**5. Dry-run first.**

```bash
node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" apply resume.tex --suggestions /tmp/sugg.json --dry-run
```

Exit code 2 means at least one suggestion failed. The usual cause is an `anchor` that isn't a character-exact substring. Fix the anchor by copying from the `blocks --json` output and re-run — do not "fix" it by loosening the text.

**6. Show the user the suggestions and let them choose** before writing anything. Present each as: what changes, and which JD requirement it serves. This is a resume; they must approve it.

**7. Apply**, then archive with the job description so the pairing is recoverable later.

## Suggestion schema

A JSON array, or `{"suggestions": [...]}`.

```json
[
  {
    "id": "s1",
    "type": "reword",
    "anchor": "\\resumeItem{Worked on the internal asset registry API.}",
    "replacement": "\\resumeItem{Built and maintained the internal asset registry API.}",
    "line": 12,
    "rationale": "JD asks for 3+ years of backend ownership; 'worked on' understates it.",
    "confidence": "high"
  },
  { "id": "s2", "type": "block_comment",   "blockId": "recipe-app-react-firebase", "rationale": "JD explicitly excludes frontend work." },
  { "id": "s3", "type": "block_uncomment", "blockId": "chess-engine-c",            "rationale": "C++ performance work is a listed nice-to-have." },
  { "id": "s4", "type": "block_move",      "blockId": "kafka-event-pipeline",      "afterBlockId": "backend-engineer", "rationale": "Closest match in the document; should be read first." }
]
```

| type | required | effect |
|---|---|---|
| `reword` | `anchor`, `replacement` | Replaces exact text. `line` disambiguates if the anchor appears more than once. |
| `block_comment` | `blockId` | Hides a block. |
| `block_uncomment` | `blockId` | Restores a hidden block. |
| `block_move` | `blockId` | Reorders. `afterBlockId` places it after that block; omit to move to section start. |

## Hard rules

**Never invent.** Do not add metrics, employers, dates, technologies, team sizes, or scope the resume doesn't already claim. You may sharpen a weak verb, make an implied detail explicit, and re-emphasize existing work toward the job. You may not manufacture a number. A resume is a factual document the user signs their name to, and an invented figure is one they'll have to defend in an interview.

If a bullet would be much stronger with a metric, say so to the user as a question — "do you have a latency number for this?" — rather than filling one in.

**Anchors must be copied character-for-character** from the `blocks --json` output, including LaTeX escapes and backslashes. If you can't copy it exactly, drop the suggestion.

**Replacements must be valid LaTeX** using only macros already present in the document. Escape `%`, `&`, `_`, `#` as `\%`, `\&`, `\_`, `\#`. An unescaped `%` silently comments out the rest of the line.

**Respect length.** Resumes are usually one page. If you uncomment two blocks, comment out roughly two. The CLI does not check page count — if the user needs certainty, tell them to compile.

**Prefer 5–12 high-value suggestions** over exhaustive coverage, ordered most impactful first.

## Judgment notes

- The strongest single move is usually reordering, not rewording — putting the most relevant project first costs nothing and changes what a recruiter reads in their first ten seconds.
- Hiding a block is not deletion. It stays in the file as comments, so restoring it later is one suggestion.
- A block that's `"commented": true` was hidden deliberately for some earlier application. Restoring it needs a reason from *this* job description.
- When the job description explicitly excludes something ("this role does not involve frontend work"), that's the clearest possible signal to hide matching blocks.
