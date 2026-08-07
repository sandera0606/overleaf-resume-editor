# Overleaf Resume Optimizer

Tailors a LaTeX resume in Overleaf to a job description, using a model that runs from your own machine.

Name your resume `master.tex`, paste a job description (or a link to one), and it writes a tailored copy to `versions/<job>.tex`. **`master.tex` is never modified** — it stays the superset every application is cut from.

It does three things: rewords bullets, hides projects/roles that don't fit the job, and un-hides ones that do. Every change is reviewed one at a time before any file is created.

## How it fits together

```
Overleaf tab                  Chrome extension          Local server          Model
------------                  ----------------          ------------          -----
master.tex                                              parse blocks
  via /download/zip  ──────>  content script  ───────>   (latex.js)
                                                             │
                             sidebar review  <───────    suggestions  <────  claude -p
                                    │                    (edits.js)          or an API key
                                    v                         │
versions/acme.tex  <────────  create file                     └──> archive/2026-08-07_acme.tex
  (new doc, opens in editor)  via /upload
```

Reading and writing use different paths on purpose. Reads go through the project zip (same-origin, so your session cookie handles auth). Writes go through Overleaf's upload endpoint, which turns an uploaded `.tex` into a real editable doc — and returns the *same* entity when the filename already exists, so re-running a job updates that job's file instead of piling up duplicates.

## Requirements

- **Node 18+** — no `npm install` needed, the server has zero dependencies
- **An engine**, either one:
  - **Claude CLI** on your `PATH` (`claude --version` works) — the default, no key to manage
  - **An API key** for Anthropic, OpenAI, or Google Gemini
- **Chrome**, and an Overleaf project you can open

## What your project needs to look like

Starting from **Jake's Resume** (what most people use)? It works, with one rename. Here is the whole compatibility story.

```
master.tex          your resume — the superset, never modified
versions/           tailored copies land here (created for you if missing)
  acme.tex
  globex.tex
styles/             optional; macros can live inline instead
```

### 1. Any `.tex` works — `master.tex` just wins automatically

You don't have to rename anything. Every `.tex` in the project is a valid source and appears in the picker; the tool only *prefers* one, and tells you which and why:

| Preference | Example | Panel says |
|---|---|---|
| 1. `master.tex` at the root | `master.tex` | the documented convention |
| 2. A standard main-document name | `main.tex`, `resume.tex`, `cv.tex` | a standard main-document name |
| 3. Whichever root `.tex` has the most content | `sandra_resume_v3.tex` | the file with the most resume content |
| — Never | `versions/acme.tex` | *excluded entirely* |

Jake's Resume ships as **`main.tex`**, so it's picked up with no changes at all. Renaming to `master.tex` only removes the "best guess" note.

**Generated files in `versions/` are never offered as a source.** Tailoring from last week's application would compound one job's cuts into the next, quietly narrowing your resume every run.

`versions/` is created for you on the first run — you don't need to make it.

### 2. Keep `\section{...}` headings uncommented

This is the one rule that bites silently.

```latex
% ---------- SUPPORTED: park a block, keep its heading ----------
\section{Projects}
  \resumeSubHeadingListStart
    \resumeProjectHeading{\textbf{Shown Project}}{2024}
%   \resumeProjectHeading{\textbf{Parked Project}}{2023}   <- selectable again
  \resumeSubHeadingListEnd

% ---------- NOT SUPPORTED: comment the whole section ----------
% \section{Awards}                                         <- everything inside
%   \resumeProjectHeading{\textbf{Scholarship}}{2024}         is invisible
```

Commenting the `\section` line hides its blocks **from the parser entirely** — they can never be selected, no matter how relevant they are to a job. Comment individual blocks instead. (`select.test.js` pins this, so if it ever changes it changes on purpose.)

### 3. Blocks need a recognised heading macro

Out of the box: `\resumeSubheading`, `\resumeProjectHeading`, `\resumeSubItem`, `\cventry`, `\cvitem` — covering Jake's Resume, sb2nov, and moderncv. Add your own to `headingMacros` in `config.json`, or mark blocks explicitly:

```latex
% >>> BLOCK: Kafka Event Pipeline
\myCustomProject{...}
% <<< END
```

Sentinel markers take priority over macro detection, so they're a reliable escape hatch.

### 4. Loose content is kept, never reordered

Jake's **Technical Skills** is a raw `\begin{itemize}` with no heading macro, so it contains no addressable blocks. Content like that is treated as fixed furniture: always kept, never hidden or reordered, and counted against the page budget as overhead. That's usually what you want for a skills list.

### 5. Page geometry is read from your document

`\documentclass[letterpaper,11pt]` plus any `\addtolength{\textwidth}{...}` / `{\textheight}{...}`, whether those sit inline in the `.tex` (as in stock Jake's) or in a separate `.sty`. Nothing to configure.

| | Stock Jake's Resume | This project's convention |
|---|---|---|
| Main file | `main.tex` | `master.tex` *(rename)* |
| Macros | inline | inline **or** `styles/*.sty` |
| `versions/` | none | created automatically |
| Addressable blocks | 7 | as many as you add |

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
  Engine:   Claude CLI — model (provider default)
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

## Choosing an engine

The default needs no configuration: if `claude` is on your `PATH`, it's used. To use an API key instead, set `provider` in `server/config.json`:

| `provider` | Key from | Default model |
|---|---|---|
| `cli` *(default)* | — uses the CLI's own login | CLI default |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-2.5-pro` |

```jsonc
{
  "provider": "anthropic",
  "model": null,                 // null = the default above
  "apiKeys": { "anthropic": "" } // optional — the env var wins if both are set
}
```

**The key never touches the browser.** It's read by the server only, which binds `127.0.0.1` and requires a token on every route. The extension asks the server to *"analyze this"* and never sees a credential. Environment variables are checked before `config.json`, so you can keep the key out of the file entirely; when it is written there, the file is created mode `0600`. Anything key-shaped is redacted from logs and error messages.

Worth stating plainly: whichever provider you pick, **your resume and the job description are sent to it.** The CLI default sends them to Anthropic under your existing Claude login.

## Using it

1. **Check the source.** `master.tex` is detected automatically.
2. **Give it the job** — paste a URL and hit *Fetch*, or paste the description directly. Fetching works on server-rendered boards (Greenhouse, Lever, Ashby, most company career pages); LinkedIn, Workday, and Indeed block automated fetches and will tell you to paste instead.
3. **Add a label** (`Acme — Backend Engineer`). It names the file — the panel previews `versions/acme-backend-engineer.tex` as you type.
4. **Analyze & create file.** Takes 20–60s, then the file appears in `versions/` and opens in the editor.
5. **Review the rewords**, one at a time. Each is highlighted on the real text in the editor with **✓ accept** / **✕ skip** floating beside it; the sidebar lists them all, and clicking any row jumps to it. A copy is archived when you finish.

The two kinds of change are treated differently on purpose:

| | |
|---|---|
| **Structural** — hide, un-hide, reorder | Applied automatically. Mechanical, reversible, and covered by the balance tests. Your wording is copied verbatim. |
| **Rewords** | Reviewed one at a time on the actual text. This is the part that can put words in your mouth, so nothing lands unseen. |

Rewords are re-anchored against the generated file by text search, never by stored offset — accepting one shifts every position after it. Any reword landing in a block this run hid is dropped rather than shown, since editing a commented-out line changes nothing that renders; the panel tells you how many were skipped.

Each application leaves three files behind:

```
archive/
  2026-08-07_acme-backend-engineer.tex        the tailored resume
  2026-08-07_acme-backend-engineer.jd.txt     the job description it was tailored to
  2026-08-07_acme-backend-engineer.meta.json  when, from which file, where it was written
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

## Fitting one page

The point of a master resume is that it can be *much* longer than one page — every role, every project, every award you might ever want to cite. Each run picks the subset that fits.

```
model ranks every block by relevance to the job
        ↓
select:  fill the page budget, highest relevance first
order:   dated sections   → newest first
         undated sections → most relevant first
```

The split is deliberate: **the model decides what is relevant, the code decides what fits.** Page height is arithmetic, not judgment, and the old prompt rule that tried to make the model do it ("if you uncomment N blocks, comment out a comparable amount") was the weakest instruction in the file.

Ordering follows résumé convention rather than raw relevance. Sections whose blocks carry dates stay reverse-chronological — recruiters read progression and gaps from date order, so shuffling Experience by relevance reads as a mistake. Sections without dates (Projects, Awards) lead with the most relevant block, where there's no convention to violate. Which sections are dated is detected from your source, not assumed from section names, so a template that dates its projects gets chronological projects.

**The page estimate is an estimate.** Only TeX knows where lines actually break, and Overleaf will only compile the project's *root* document — so the generated file can't be measured without mutating your project settings, which this tool won't do. The estimator reads your real geometry and reports in inches, hedging to `borderline` near the limit rather than guessing. Overleaf's own preview gives you the true page count the moment the file compiles.

## Safety properties

These are the invariants the test suite enforces (`npm test`, 19 tests):

- **`master.tex` is never written to.** Every run creates or replaces a file in `versions/`. The worst case for a bad run is a bad version file, not a damaged master.
- **Rewords are anchored to exact text, never line numbers.** If the anchor isn't found, that suggestion fails and reports why rather than writing to a guessed location.
- **A failed suggestion never modifies the file.**
- **Comment → uncomment round-trips byte-for-byte**, including indentation.
- **Every edit leaves LaTeX delimiters balanced.** Blocks fully contain their own `\resumeItemListStart`/`End` pair, so hiding one can't leave a dangling delimiter. This is checked exhaustively across every block and every pairwise reorder.
- **Writes are refused if the source drifted.** The project is re-read just before writing; if `master.tex` changed since Analyze, the write is rejected, because those suggestions were computed against text that no longer exists.

The server binds `127.0.0.1` only and requires a token on every route except `/health` and `/pair`.

## Known limits

- **No page-count check.** Un-hiding projects can push you to two pages; you'll see it in Overleaf's preview, but nothing warns you first.
- **The write path is unofficial.** Overleaf has no public write API, so creating the file uses the same endpoint its web UI uses. An Overleaf change could break it; reading via zip is unaffected. One page-world detail (the root folder id, needed only to create `versions/` the first time) comes from React internals via `page-bridge.js` — if that fails, the panel tells you to create the folder by hand once.
- **Job-link fetching is best-effort.** No headless browser, so client-side-rendered and bot-walled boards can't be read. The failure is explicit, never a silently empty description.
- **One-shot analysis.** The server makes a single model call; it doesn't iterate or compile.

## Development

```bash
cd server
npm test          # 19 tests, node:test, no framework
```

The tests run against `server/test/fixtures/sample-resume.tex` and need neither the server nor Claude CLI running.

After editing anything in `extension/`, reload it at `chrome://extensions` (circular arrow on the card) and refresh the Overleaf tab. Content scripts and the MAIN-world bridges don't hot-reload.

Server logs every analysis to stdout — suggestion count, elapsed time, cost, and any suggestions dropped as malformed. That's the first place to look when output seems off.

## Layout

Three front ends over one engine — the parser and applier are shared, so a fix
in `latex.js` lands in all of them.

```
server/
  src/latex.js    block parser — the heart of it
  src/edits.js    suggestion application, phased and re-parsed between phases
  src/prompt.js   prompt, response schema, and JSON coercion (provider-agnostic)
  src/claude.js   analysis entry point: prompt -> provider -> suggestions
  src/providers/  cli.js · anthropic.js · openai.js · gemini.js + key resolution
  src/jd.js       job URL -> plain text
  src/zip.js      minimal zip reader for Overleaf downloads
  src/index.js    HTTP routes        <- front end 1: the extension
  src/cli.js      command line       <- front end 2: the plugin, and you
  test/           19 tests, no framework

extension/        front end 1 — Overleaf, in the browser
  overleaf.js     project file API (read tree, create folder, write doc)
  cm-review.js    MAIN-world: highlight / accept / reject inside CodeMirror
  page-bridge.js  MAIN-world: the one value React won't share with a content script
  content.js      sidebar UI
  background.js   the only thing that talks to the server

.claude-plugin/   front end 2 — Claude Code, in the terminal
  plugin.json
  marketplace.json
skills/tailor-resume/SKILL.md    workflow, schema, and the never-invent rule
commands/tailor.md               /tailor
commands/resume-blocks.md        /resume-blocks
```
