---
description: Show the addressable blocks in a LaTeX resume, and which are hidden
allowed-tools: Bash(node:*), Read, Glob
---

## Context

- Resume files here: !`ls *.tex **/*.tex 2>/dev/null | head -20 || echo "(none in cwd)"`

## Your task

Show the block structure of a resume so the user can see what's currently shown versus hidden.

Target: `$ARGUMENTS` — if empty, use the obvious `.tex` from the list above, or ask when several are plausible.

```bash
node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" blocks <file.tex>
```

Present the result grouped by section, making clear which blocks are commented out. Then briefly note what stands out — a section with nothing hidden, a hidden block that looks generally strong, an ordering that buries the best item.

If it reports zero blocks, the template uses macros the parser doesn't recognize. Explain the two fixes: add the macro to `headingMacros` in `server/config.json`, or wrap items in `% >>> BLOCK: Name` / `% <<< END` sentinels.
