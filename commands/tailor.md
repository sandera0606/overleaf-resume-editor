---
description: Tailor a LaTeX resume to a job description
allowed-tools: Bash(node:*), Read, Write, Glob, Grep
---

## Context

- Resume files here: !`ls *.tex **/*.tex 2>/dev/null | head -20 || echo "(none in cwd)"`
- Previously archived: !`node "$CLAUDE_PLUGIN_ROOT/server/src/cli.js" list 2>/dev/null | head -12 || echo "(none yet)"`

## Your task

Tailor a resume to a job description. Arguments: `$ARGUMENTS`

Arguments may name a resume file, a job-description file, both, or neither.

1. **Resolve inputs.** If the resume isn't clear from the arguments or the list above, ask. If the job description wasn't given as a file, ask the user to paste it.

2. **Follow the `tailor-resume` skill.** Inventory blocks with the CLI, propose suggestions, dry-run them.

3. **Show the user what you propose before applying anything.** Group by type — rewordings, what you'd hide, what you'd restore, what you'd reorder — each with the JD requirement it serves. Let them drop any they don't want.

4. **Apply and archive** once they've approved.

Never invent metrics, technologies, or scope not already in the resume. Sharpen wording; don't fabricate substance.
