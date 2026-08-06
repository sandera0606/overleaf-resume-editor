# Overleaf Resume Optimizer

Tailors a LaTeX resume in Overleaf to a job description, using Claude CLI running on your own machine.

It does three things: rewords bullets, hides projects/roles that don't fit the job, and un-hides ones that do. Every change is reviewed one at a time before anything touches your document.

## How it fits together

```
Overleaf tab                    Chrome extension              Local server           Claude CLI
------------                    ----------------              ------------           ----------
/download/zip  ──────────────>  content script  ───────────>  parse blocks
                                                              (latex.js)
CodeMirror 6   <─ one undoable   sidebar review  <───────────  suggestions  <───────  claude -p
                  transaction                                 (edits.js)
                                                                   │
                                                                   └──> archive/2026-08-06_acme.tex
```

The extension reads the whole project as a zip (same-origin, so your session cookie handles auth) and writes back through CodeMirror in a single transaction — so **Ctrl+Z undoes the whole thing** and Overleaf's normal sync persists it.

## Requirements

- **Node 18+** — no `npm install` needed, the server has zero dependencies
- **Claude CLI** on your `PATH` (`claude --version` should work)
- **Chrome**, and an Overleaf project you can open

## Setup

### 1. Start the server

```bash
cd server
npm start
```

You should see:

```
  Resume optimizer listening on http://127.0.0.1:8787
  Archive:  .../resume-chrome-extension/archive
  Model:    (CLI default)
  Pairing:  open for 5 min — click "Connect" in the extension now.
```

**This is a long-running server — it never exits on its own.** Leave the terminal open and use a second one for anything else. Stop it with `Ctrl+C`.

First run generates `server/config.json` with an auth token. That file is gitignored; don't commit it.

<details>
<summary><strong>Troubleshooting the server</strong></summary>

**`Port 8787 is already in use`** — it's already running somewhere. Find and stop it:

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }
Stop-Process -Id <pid>
```

```bash
# macOS / Linux
lsof -i :8787
kill <pid>
```

Or change `"port"` in `server/config.json` and update the port in the extension to match.

**Check it's actually up** — from another terminal:

```bash
curl http://127.0.0.1:8787/health
```

**`Could not launch Claude CLI`** — `claude` isn't on the PATH of the shell that started the server. Verify with `claude --version` in that same shell.

**Analysis times out** — the CLI call has a 180s ceiling. A very long job description plus a large resume can hit it; trim the JD to the requirements section.

</details>

### 2. Load the extension

`chrome://extensions` → enable **Developer mode** (top right) → **Load unpacked** → select the `extension/` folder.

Chrome will show it as *Overleaf Resume Optimizer*. Pin it so the toolbar icon is visible — that icon is how you open the sidebar.

### 3. Connect

Open an Overleaf project, click the extension icon, then click **Connect to local server**.

Pairing is open for **5 minutes after the server starts**, so the token transfers without copy-paste. Miss the window and you have two options: restart the server for a fresh one, or copy `token` out of `server/config.json` — it persists across restarts.

> The extension only activates on `overleaf.com/project/*` URLs. On any other page the toolbar icon does nothing.

## Using it

1. Pick the resume file. The open file is auto-detected by matching editor text against the project zip, so it doesn't depend on Overleaf's DOM.
2. Paste the job description.
3. Add a label (`Acme — Backend Engineer`) — it names the archive file.
4. **Analyze**. Takes 20–60s.
5. Review. Everything is checked by default; uncheck what you don't want.
6. **Apply**. Edits land in Overleaf, and a copy is saved to `archive/`.

Each application leaves three files behind:

```
archive/
  2026-08-06_acme-backend-engineer.tex        the tailored resume
  2026-08-06_acme-backend-engineer.jd.txt     the job description it was tailored to
  2026-08-06_acme-backend-engineer.meta.json  when, from which file, how many edits
```

## Using it from the terminal (Claude Code plugin)

The same engine ships as a Claude Code plugin, for when you'd rather not touch the browser. It works on local `.tex` files — no server, no extension, no Overleaf.

```bash
claude plugin marketplace add sandera0606/overleaf-resume-editor
claude plugin install resume-optimizer@overleaf-resume-editor
```

Then:

| | |
|---|---|
| `/tailor resume.tex jd.txt` | Tailor a resume to a job description |
| `/resume-blocks resume.tex` | Show what's currently shown vs. hidden |

Claude proposes the changes and shows them to you grouped by type before anything is written; you drop what you don't want.

The plugin does the *judgment* — which experience fits the job, how to phrase it — while the same tested parser does the *mechanics*. It's told explicitly not to hand-edit the LaTeX, because commenting out a block by hand orphans its `\resumeItemListEnd` and breaks the build. That's a real bug this project already hit.

### The CLI directly

The plugin is a wrapper over `server/src/cli.js`, which is usable on its own:

```bash
node server/src/cli.js blocks  resume.tex [--json]
node server/src/cli.js apply   resume.tex --suggestions sugg.json [--out FILE | --in-place] [--dry-run]
node server/src/cli.js archive resume.tex --label "Acme — Backend" --jd jd.txt
node server/src/cli.js list
```

`apply` writes nothing unless you pass `--out` or `--in-place` (which backs up to `.bak` first), and **exits 2 if any suggestion failed** — so `--dry-run` is a real preflight check, not just a preview.

## What it will and won't change

Claude is instructed to **sharpen, never invent**. It will strengthen weak verbs (`worked on` → `built`) and surface detail already implied by your text. It will not add metrics, employers, dates, or technologies you haven't claimed.

That constraint is in the prompt, not enforced by code — so the review step is doing real work. Read the diffs.

## Template support

Blocks are found by heading macro. Out of the box: `\resumeSubheading`, `\resumeProjectHeading`, `\resumeSubItem`, `\cventry`, `\cvitem` — which covers Jake's Resume, sb2nov, and moderncv.

If your template uses something else, either add it to `headingMacros` in `config.json`, or mark blocks explicitly:

```latex
% >>> BLOCK: Kafka Event Pipeline
\myCustomProject{...}
  ...
% <<< END
```

Sentinel markers take priority over macro detection, so they're a reliable escape hatch.

## Safety properties

These are the invariants the test suite enforces (`npm test`, 19 tests):

- **Rewords are anchored to exact text, never line numbers.** If the anchor isn't found, that suggestion fails and reports why rather than writing to a guessed location.
- **A failed suggestion never modifies the file.**
- **Comment → uncomment round-trips byte-for-byte**, including indentation.
- **Every edit leaves LaTeX delimiters balanced.** Blocks fully contain their own `\resumeItemListStart`/`End` pair, so hiding one can't leave a dangling delimiter. This is checked exhaustively across every block and every pairwise reorder.
- **Writes are refused if the file drifted.** If you edit in Overleaf between Analyze and Apply, the write is rejected rather than clobbering your change.

The server binds `127.0.0.1` only and requires a token on every route except `/health` and `/pair`.

## Known limits

- **No page-count check.** Un-hiding projects can push you to two pages; you'll see it in Overleaf's preview, but nothing warns you first.
- **CodeMirror access is unofficial.** Writing depends on internal `.cmView` properties. There's an `execCommand` fallback, but an Overleaf editor rewrite could break it. Reading via zip is unaffected.
- **Applies to the open file only.** If you pick a file that isn't open in the editor, open it first.
- **One-shot analysis.** The server makes a single `claude -p` call; it doesn't iterate or compile.

## Development

```bash
cd server
npm test          # 19 tests, node:test, no framework
```

The tests run against `server/test/fixtures/sample-resume.tex` and need neither the server nor Claude CLI running.

After editing anything in `extension/`, reload it at `chrome://extensions` (circular arrow on the card) and refresh the Overleaf tab. Changes to `cm-bridge.js` and `content.js` don't hot-reload.

Server logs every analysis to stdout — suggestion count, elapsed time, cost, and any suggestions dropped as malformed. That's the first place to look when output seems off.

## Layout

Three front ends over one engine — the parser and applier are shared, so a fix
in `latex.js` lands in all of them.

```
server/
  src/latex.js    block parser — the heart of it
  src/edits.js    suggestion application, phased and re-parsed between phases
  src/claude.js   CLI invocation + prompt (used by the HTTP server)
  src/zip.js      minimal zip reader for Overleaf downloads
  src/index.js    HTTP routes        <- front end 1: the extension
  src/cli.js      command line       <- front end 2: the plugin, and you
  test/           19 tests, no framework

extension/        front end 1 — Overleaf, in the browser
  cm-bridge.js    MAIN-world CodeMirror access
  content.js      sidebar UI
  background.js   the only thing that talks to the server

.claude-plugin/   front end 2 — Claude Code, in the terminal
  plugin.json
  marketplace.json
skills/tailor-resume/SKILL.md    workflow, schema, and the never-invent rule
commands/tailor.md               /tailor
commands/resume-blocks.md        /resume-blocks
```
