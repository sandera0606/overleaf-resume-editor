/**
 * Sidebar UI injected into an Overleaf project page.
 *
 * The flow, and why it splits the way it does:
 *
 *   master.tex  ──> structural changes (hide / show / reorder) applied
 *                   automatically, wording untouched
 *               ──> written as a NEW file, versions/<job>.tex
 *               ──> rewords reviewed one at a time, highlighted in the editor
 *
 * Structural edits are mechanical and covered by the balance tests, so they run
 * unattended. Rewords are the part that can put words in your mouth, so every
 * one is shown on the real text with accept/reject before it lands.
 *
 * master.tex is never written to.
 *
 * All rendering uses textContent rather than innerHTML: suggestion text comes
 * from a language model and lands inside a privileged extension context, so it
 * is treated as untrusted throughout.
 */

(() => {
  if (window.__resumeOptimizerLoaded) return;
  window.__resumeOptimizerLoaded = true;

  const overleaf = window.__resumeOptimizerOverleaf;
  const MASTER = 'master.tex';
  const VERSIONS = 'versions';
  const STRUCTURAL = new Set(['block_comment', 'block_uncomment', 'block_move']);

  // ---------------------------------------------------------------- bridge --

  const TAG_PAGE = 'resume-optimizer-page';
  const TAG_CONTENT = 'resume-optimizer-content';
  let bridgeSeq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.tag !== TAG_PAGE) return;
    const { id, payload, type } = event.data;
    if (type === 'SCROLLED') return; // no overlay to reposition
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(payload);
    }
  });

  function bridge(type, payload = {}, timeoutMs = 8000) {
    const id = ++bridgeSeq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window.postMessage({ tag: TAG_CONTENT, id, type, payload }, '*');
      setTimeout(() => {
        if (pending.delete(id)) {
          resolve({ ok: false, error: 'The editor bridge did not respond. Try reloading the page.' });
        }
      }, timeoutMs);
    });
  }

  function server(action, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action, payload }, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: 'No response from the extension background worker.' });
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ----------------------------------------------------------------- state --

  const state = {
    connected: false,
    sources: {},
    files: [],
    selected: null,
    phase: 'setup',      // setup | review | done
    createdFile: null,
    inlineOk: false,     // did the editor bridge attach?
    structural: [],      // applied without review
    rewords: [],         // { id, anchor, replacement, rationale, confidence, occurrence, status }
    cursor: 0,
    summary: '',
    keywords: [],
  };

  // -------------------------------------------------------------- elements --

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      // Skip absent values. setAttribute stringifies, so `disabled: null` would
      // otherwise write disabled="null" — and for boolean attributes the mere
      // presence of the attribute applies it, greying out a live button.
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  };

  const root = el('div', { class: 'ro-panel', id: 'resume-optimizer' });
  const statusBar = el('div', { class: 'ro-status' });
  const body = el('div', { class: 'ro-body' });

  function setStatus(text, kind = 'info') {
    statusBar.textContent = text;
    statusBar.className = `ro-status ro-${kind}`;
  }

  // ------------------------------------------------------------ progress --

  const progressFill = el('div', { class: 'ro-progress-fill' });
  const progressLabel = el('div', { class: 'ro-progress-label' });
  const progress = el('div', { class: 'ro-progress' }, [
    el('div', { class: 'ro-progress-track' }, [progressFill]),
    progressLabel,
  ]);
  let creepTimer = null;

  /**
   * @param {number|null} pct  0-100, or null to hide the bar
   * @param {string} label
   * @param {number} [creepTo] keep drifting toward this while a slow step runs,
   *        so the bar stays alive without ever claiming more progress than made
   */
  function setProgress(pct, label = '', creepTo = null) {
    clearInterval(creepTimer);
    creepTimer = null;

    if (pct === null) {
      progress.classList.remove('ro-progress-on');
      return;
    }
    progress.classList.add('ro-progress-on');
    progressLabel.textContent = label;
    let at = pct;
    progressFill.style.width = `${at}%`;

    if (creepTo !== null && creepTo > pct) {
      // Asymptotic approach to the cap: always moving, never arriving. A step
      // that stalls at a fixed number reads as hung, and one that fills to the
      // cap implies work that hasn't happened — this does neither. Tuned so a
      // 20s call lands near a third and a 60s call near half.
      const started = Date.now();
      const span = creepTo - pct;
      creepTimer = setInterval(() => {
        const elapsed = Date.now() - started;
        at = pct + span * (1 - Math.exp(-elapsed / 25000));
        progressFill.style.width = `${at}%`;
      }, 250);
    }
  }

  function failProgress() {
    clearInterval(creepTimer);
    creepTimer = null;
    progress.classList.add('ro-progress-fail');
    setTimeout(() => progress.classList.remove('ro-progress-fail'), 2000);
    setTimeout(() => progress.classList.remove('ro-progress-on'), 2000);
  }

  function toggle(force) {
    const show = force ?? !root.classList.contains('ro-open');
    root.classList.toggle('ro-open', show);
    document.body.classList.toggle('ro-shifted', show);
  }

  function slugify(label) {
    return (label || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60);
  }

  // The highlight lives in the editor; the decision lives in the panel.
  // An overlay pinned to the text competed with Overleaf's own UI and moved
  // under the cursor as the document reflowed, so accept/skip stays in one
  // predictable place instead.

  // ------------------------------------------------------------ zip loading --

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function fetchProject() {
    const id = overleaf.projectId();
    if (!id) throw new Error('Could not read the project id from the URL.');
    const res = await fetch(`/project/${id}/download/zip`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Overleaf refused the project download (${res.status}).`);
    const out = await server('project', { zipBase64: toBase64(await res.arrayBuffer()) });
    if (!out.ok) throw new Error(out.error);
    return out.data;
  }

  const PICK_REASON = {
    convention: `${MASTER} — the documented convention`,
    'known-name': 'a standard main-document name',
    'most-blocks': 'the file with the most resume content',
    'best-guess': 'best guess',
  };

  async function loadProject() {
    setStatus('Reading project…');
    const data = await fetchProject();
    state.sources = data.sources;
    state.files = data.files;
    // The server ranks candidates and excludes generated versions/. Keep the
    // user's choice if they already overrode it and the file still exists.
    state.candidates = data.candidates || data.files.map((f) => f.name);
    state.pickReason = data.suggestedReason || 'best-guess';
    if (!state.selected || !state.candidates.includes(state.selected)) {
      state.selected = data.suggested || state.candidates[0] || null;
    }

    render();
    if (!state.selected) {
      return setStatus('No usable .tex found — versions/ holds generated output, not sources.', 'err');
    }
    setStatus(
      state.pickReason === 'convention'
        ? `Found ${MASTER}. Paste a job to tailor it.`
        : `Using ${state.selected} — ${PICK_REASON[state.pickReason]}.`,
      state.pickReason === 'convention' ? 'ok' : 'warn',
    );
  }

  // -------------------------------------------------------------- rendering --

  function renderConnect() {
    return el('div', { class: 'ro-step' }, [
      el('p', { class: 'ro-hint', text: 'Start the local server, then connect. Pairing is open for a few minutes after the server starts.' }),
      el('button', {
        class: 'ro-btn ro-primary',
        text: 'Connect to local server',
        onclick: async (e) => {
          e.target.disabled = true;
          setStatus('Connecting…');
          const res = await server('connect');
          e.target.disabled = false;
          if (!res.ok) return setStatus(res.error, 'err');
          state.connected = true;
          render();
          loadProject().catch((err) => setStatus(err.message, 'err'));
        },
      }),
    ]);
  }

  function renderSource() {
    const byConvention = state.pickReason === 'convention';
    const info = state.files.find((f) => f.name === state.selected);
    const candidates = state.candidates || [];

    // Always offer the picker: any .tex in the tree is a valid source, and the
    // ranking is a preference rather than a rule.
    const picker = el('select', {
      class: 'ro-select',
      onchange: (e) => { state.selected = e.target.value; render(); },
    });
    for (const name of candidates) {
      const f = state.files.find((x) => x.name === name) || { blocks: 0, active: 0, hidden: 0 };
      const opt = el('option', { value: name });
      opt.textContent = `${name} — ${f.blocks || 0} blocks (${f.active || 0} shown, ${f.hidden || 0} hidden)`;
      if (name === state.selected) opt.selected = true;
      picker.appendChild(opt);
    }

    return el('div', { class: 'ro-step' }, [
      el('label', { class: 'ro-label', text: 'Tailoring from' }),
      el('div', { class: `ro-source${byConvention ? '' : ' ro-source-guess'}` }, [
        el('span', { class: 'ro-source-name', text: state.selected || '(none)' }),
        el('span', {
          class: 'ro-source-meta',
          text: `${info?.blocks || 0} blocks · never modified${byConvention ? '' : ` · ${PICK_REASON[state.pickReason]}`}`,
        }),
      ]),
      !byConvention && state.selected
        ? el('div', { class: 'ro-callout', text: `Rename it to ${MASTER} to have it picked automatically. Any .tex works — generated files in ${VERSIONS}/ are excluded.` })
        : null,
      candidates.length > 1 ? picker : null,
    ]);
  }

  const urlInput = el('input', { class: 'ro-input', type: 'url', placeholder: 'https://jobs.example.com/…  (optional)' });
  const jdInput = el('textarea', { class: 'ro-textarea', rows: '8', placeholder: '…or paste the job description here' });
  const labelInput = el('input', { class: 'ro-input', type: 'text', placeholder: 'e.g. Acme — Backend Engineer' });
  const filePreview = el('div', { class: 'ro-preview' });

  function updatePreview() {
    filePreview.textContent = `→ ${VERSIONS}/${slugify(labelInput.value) || 'untitled'}.tex`;
  }
  labelInput.addEventListener('input', updatePreview);
  updatePreview();

  function renderJob() {
    return el('div', { class: 'ro-step' }, [
      el('label', { class: 'ro-label', text: 'Job posting' }),
      el('div', { class: 'ro-row' }, [
        urlInput,
        el('button', {
          class: 'ro-btn ro-ghost', text: 'Fetch',
          onclick: async (e) => {
            const url = urlInput.value.trim();
            if (!url) return setStatus('Paste a job URL first.', 'err');
            e.target.disabled = true;
            setStatus('Fetching the posting…');
            const res = await server('jd', { url });
            e.target.disabled = false;
            if (!res.ok) return setStatus(res.error, 'warn');
            jdInput.value = res.data.text;
            if (!labelInput.value.trim() && res.data.title) {
              labelInput.value = res.data.title.slice(0, 80);
              updatePreview();
            }
            setStatus(`Loaded ${res.data.text.length} chars. Check it, then run.`, 'ok');
          },
        }),
      ]),
      jdInput,
      el('label', { class: 'ro-label', text: 'Label' }),
      labelInput,
      filePreview,
      el('button', { class: 'ro-btn ro-primary', text: 'Analyze & create file', onclick: (e) => run(e.target) }),
    ]);
  }

  // ------------------------------------------------------------ the run --

  async function run(button) {
    const jd = jdInput.value.trim();
    const label = labelInput.value.trim();
    if (!jd) return setStatus('Paste a job description, or fetch one from a URL.', 'err');
    if (!label) return setStatus('Add a label — it names the file.', 'err');
    if (!state.selected) return setStatus('No resume file loaded.', 'err');

    button.disabled = true;
    try {
      // The model call dominates the wall clock, so it owns most of the bar.
      setProgress(4, 'Asking the model…', 55);
      setStatus('Asking the model… this usually takes 20–60s.');
      const source = state.sources[state.selected];
      const res = await server('analyze', { jobDescription: jd, source, filename: state.selected });
      if (!res.ok) throw new Error(res.error);

      state.summary = res.data.summary;
      state.keywords = res.data.keywords || [];
      // Structural edits come from the server's page-budget plan, not from the
      // model. The model ranks; the plan decides what fits and in what order.
      state.structural = res.data.structural || res.data.suggestions.filter((s) => STRUCTURAL.has(s.type));
      state.plan = res.data.plan || null;
      state.unranked = res.data.unranked || 0;
      const rewords = res.data.suggestions.filter((s) => s.type === 'reword');

      // Guard against a stale base before writing anything.
      setProgress(60, 'Checking the source is unchanged…');
      setStatus('Checking the source is unchanged…');
      const fresh = await fetchProject();
      if (fresh.sources[state.selected] !== source) {
        throw new Error(`${state.selected} changed in Overleaf since it was read. Reload and try again.`);
      }

      // Structural changes only — your wording, verbatim.
      let text = source;
      if (state.structural.length) {
        setProgress(70, `Applying ${state.structural.length} structural change(s)…`);
        const applied = await server('apply', { source, suggestions: state.structural });
        if (!applied.ok) throw new Error(applied.error);
        text = applied.data.text;
        state.structuralFailed = applied.data.results.filter((r) => r.status === 'failed');
      }

      setProgress(80, 'Creating the file in Overleaf…');
      setStatus('Creating the file in Overleaf…');
      const filename = `${slugify(label) || 'untitled'}.tex`;
      const folderId = await overleaf.ensureFolder(VERSIONS);
      await overleaf.writeDoc(folderId, filename, text);
      state.createdFile = `${VERSIONS}/${filename}`;

      setProgress(88, 'Opening the new file…');
      const opened = await openAndConfirm(VERSIONS, filename, text);

      // Re-anchor rewords against what the editor actually holds. Offsets from
      // master are meaningless here — blocks moved — so match by text, and drop
      // anything that landed in a block this run hid.
      state.rewords = [];
      if (rewords.length && opened) {
        setProgress(94, 'Preparing review…');
        const attached = await bridge('ATTACH');
        state.inlineOk = !!attached.ok;

        const resolved = await bridge('RESOLVE', { anchors: rewords.map((r) => r.anchor) });
        const info = resolved.ok ? resolved.results : [];
        rewords.forEach((r, i) => {
          const hit = info[i];
          if (!hit?.found) return;                 // text isn't there any more
          if (hit.commented) return;               // block is hidden; reword would be a no-op
          state.rewords.push({ ...r, occurrence: hit.occurrence, status: 'pending' });
        });
        state.dropped = rewords.length - state.rewords.length;
      }

      state.blockedRewords = rewords.length && !opened ? rewords.length : 0;
      state.cursor = 0;
      state.phase = state.rewords.length ? 'review' : 'done';
      setProgress(100, 'Done');
      setTimeout(() => setProgress(null), 700);
      render();

      if (state.phase === 'review') {
        await showCurrent();
        setStatus(`Created ${state.createdFile}. ${state.rewords.length} reword(s) to review.`, 'ok');
      } else {
        await finish();
      }
    } catch (err) {
      failProgress();
      setStatus(err.message, 'err');
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Open the new file and confirm the editor is really showing it.
   *
   * Overleaf's file tree lags the API: on a first run the freshly created
   * folder may not be in the DOM yet, so the click target doesn't exist and the
   * editor stays on master.tex. Reviewing then would highlight and rewrite
   * master — exactly what this flow promises not to touch — so the editor's own
   * text is the gate, not whether the click appeared to work.
   */
  async function openAndConfirm(folderName, filename, expected) {
    const head = expected.slice(0, 120);
    for (let attempt = 0; attempt < 6; attempt++) {
      await overleaf.openFile(folderName, filename);
      await sleep(500);
      const live = await bridge('READ');
      if (live.ok && live.text.startsWith(head)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------- review --

  async function showCurrent() {
    const sugg = state.rewords[state.cursor];
    if (!sugg) return;
    render();
    if (!state.inlineOk) return;

    const res = await bridge('SHOW', {
      anchor: sugg.anchor, occurrence: sugg.occurrence, done: sugg.status === 'accepted',
    });
    if (!res.ok) {
      sugg.status = 'missing';
      render();
      return;
    }
  }

  async function decide(status) {
    const sugg = state.rewords[state.cursor];
    if (!sugg || sugg.status !== 'pending') return;

    if (status === 'accepted') {
      const res = await bridge('ACCEPT', {
        anchor: sugg.anchor, occurrence: sugg.occurrence, replacement: sugg.replacement,
      });
      if (!res.ok) {
        sugg.status = 'missing';
        setStatus(res.error, 'warn');
        render();
        return next();
      }
    }
    sugg.status = status;
    render();
    next();
  }

  function next() {
    const from = state.cursor + 1;
    const idx = state.rewords.findIndex((r, i) => i >= from && r.status === 'pending');
    const fallback = state.rewords.findIndex((r) => r.status === 'pending');
    const target = idx !== -1 ? idx : fallback;
    if (target === -1) return finish();
    state.cursor = target;
    showCurrent();
  }

  async function finish() {
    state.phase = 'done';
    await bridge('CLEAR');

    // Archive the file as it now stands, accepted rewords included.
    const live = await bridge('READ');
    const accepted = state.rewords.filter((r) => r.status === 'accepted').length;
    const archived = await server('archive', {
      label: labelInput.value.trim(),
      tex: live.ok ? live.text : '',
      jobDescription: jdInput.value,
      meta: {
        from: state.selected,
        wroteTo: state.createdFile,
        sourceUrl: urlInput.value.trim() || undefined,
        structural: state.structural.length,
        rewordsAccepted: accepted,
        rewordsOffered: state.rewords.length,
      },
    });

    render();
    const bits = [`${state.createdFile} ready`];
    bits.push(`${state.structural.length} structural`);
    if (state.rewords.length) bits.push(`${accepted}/${state.rewords.length} rewords`);
    if (archived.ok) bits.push(`archived as ${archived.data.name}.tex`);
    setStatus(bits.join(' · '), 'ok');
  }

  /** How the page budget was spent — the answer to "why did it drop that?". */
  function renderFit() {
    const p = state.plan;
    if (!p) return null;
    const e = p.estimate;
    const pct = Math.min(100, Math.round(e.fillRatio * 100));

    return el('div', { class: 'ro-fit' }, [
      el('div', { class: 'ro-fit-bar' }, [el('div', { class: 'ro-fit-fill', style: `width:${pct}%` })]),
      el('div', { class: 'ro-sub', text: `${e.shown} of ${e.shown + e.hidden} blocks · ~${e.usedIn}in of ${e.budgetIn}in (${pct}%)` }),
      state.unranked
        ? el('div', { class: 'ro-sub', text: `${state.unranked} block(s) went unranked and were treated as irrelevant.` })
        : null,
      el('div', { class: 'ro-sub ro-fit-note', text: 'Page height is estimated — check Overleaf’s preview for the real count.' }),
    ]);
  }

  const STATUS_LABEL = { pending: 'not decided', accepted: 'accepted', rejected: 'skipped', missing: 'text not found' };

  /** Move the cursor by `delta`, wrapping at both ends. */
  function step(delta) {
    if (!state.rewords.length) return;
    const n = state.rewords.length;
    state.cursor = ((state.cursor + delta) % n + n) % n;
    showCurrent();
  }

  let cardEl = null;
  function renderReviewCard() {
    if (!cardEl) return;
    const r = state.rewords[state.cursor];
    cardEl.textContent = '';
    if (!r) return;

    const decided = r.status !== 'pending';
    cardEl.appendChild(el('div', { class: `ro-card ro-card-${r.status}` }, [
      el('div', { class: 'ro-rw-head' }, [
        el('span', { class: 'ro-card-state', text: STATUS_LABEL[r.status] }),
        el('span', { class: 'ro-conf', text: r.confidence || '' }),
      ]),
      el('div', { class: 'ro-before', text: r.anchor }),
      el('div', { class: 'ro-after', text: r.replacement }),
      el('div', { class: 'ro-why', text: r.rationale || '' }),
    ]));

    cardEl.appendChild(el('div', { class: 'ro-decide' }, [
      el('button', {
        class: 'ro-btn ro-decide-no', text: '✕ Skip',
        disabled: decided ? 'true' : null,
        onclick: () => decide('rejected'),
      }),
      el('button', {
        class: 'ro-btn ro-decide-yes', text: '✓ Accept',
        disabled: decided ? 'true' : null,
        onclick: () => decide('accepted'),
      }),
    ]));
  }

  function renderNav() {
    const done = state.rewords.filter((r) => r.status !== 'pending').length;
    return el('div', { class: 'ro-nav' }, [
      el('button', { class: 'ro-nav-btn', text: '‹', title: 'Previous', onclick: () => step(-1) }),
      el('div', { class: 'ro-nav-mid' }, [
        el('div', { class: 'ro-nav-count', text: `${state.cursor + 1} of ${state.rewords.length}` }),
        el('div', { class: 'ro-nav-sub', text: `${done} decided · ${state.rewords.length - done} left` }),
      ]),
      el('button', { class: 'ro-nav-btn', text: '›', title: 'Next', onclick: () => step(1) }),
    ]);
  }

  function renderReview() {
    cardEl = el('div', { class: 'ro-card-wrap' });
    return el('div', { class: 'ro-step' }, [
      el('div', { class: 'ro-created', text: `Created ${state.createdFile}` }),
      renderFit(),
      el('div', { class: 'ro-sub', text: `${state.structural.length} structural change(s) applied · wording untouched` }),
      state.dropped
        ? el('div', { class: 'ro-sub', text: `${state.dropped} reword(s) skipped — their blocks are hidden in this version.` })
        : null,
      !state.inlineOk
        ? el('div', { class: 'ro-callout', text: 'Inline review unavailable — deciding from the panel instead.' })
        : null,
      el('label', { class: 'ro-label', text: 'Rewords' }),
      renderNav(),
      cardEl,
      el('button', { class: 'ro-btn ro-ghost', text: 'Finish review', onclick: () => finish() }),
    ]);
  }

  function renderDone() {
    const accepted = state.rewords.filter((r) => r.status === 'accepted').length;
    return el('div', { class: 'ro-step' }, [
      el('div', { class: 'ro-created', text: `${state.createdFile} is ready` }),
      renderFit(),
      el('div', { class: 'ro-sub', text: `${state.structural.length} structural · ${accepted} reword(s) accepted` }),
      state.blockedRewords
        ? el('div', { class: 'ro-callout', text: `${state.blockedRewords} reword(s) not reviewed — the new file didn't open in the editor. Open ${state.createdFile} and run again to review them.` })
        : null,
      state.summary ? el('p', { class: 'ro-summary', text: state.summary }) : null,
      state.keywords.length
        ? el('div', { class: 'ro-keywords' }, [
            el('span', { class: 'ro-label', text: 'Missing keywords' }),
            el('div', { class: 'ro-chips' }, state.keywords.map((k) => el('span', { class: 'ro-chip', text: k }))),
          ])
        : null,
      el('button', {
        class: 'ro-btn ro-primary', text: 'Tailor another job',
        onclick: () => {
          state.phase = 'setup';
          state.rewords = [];
          state.structural = [];
          state.createdFile = null;
          jdInput.value = '';
          urlInput.value = '';
          labelInput.value = '';
          updatePreview();
          render();
          loadProject().catch((err) => setStatus(err.message, 'err'));
        },
      }),
    ]);
  }

  function render() {
    body.textContent = '';
    if (!state.connected) return body.appendChild(renderConnect());
    if (state.phase === 'review') { body.appendChild(renderReview()); return renderReviewCard(); }
    if (state.phase === 'done') return body.appendChild(renderDone());
    if (state.files.length) body.appendChild(renderSource());
    body.appendChild(renderJob());
  }

  // ------------------------------------------------------------------ boot --

  root.appendChild(el('div', { class: 'ro-header' }, [
    el('span', { class: 'ro-title', text: 'Resume Optimizer' }),
    el('button', { class: 'ro-close', text: '×', onclick: () => toggle(false) }),
  ]));
  root.appendChild(statusBar);
  root.appendChild(progress);
  root.appendChild(body);

  // Icons are inlined as SVG paths rather than image files: Overleaf's CSP
  // blocks outside resources, and an extension shouldn't be fetching assets
  // over the network to render its own chrome anyway.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(path) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '17');
    svg.setAttribute('height', '17');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true'); // the link carries the label
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    svg.appendChild(p);
    return svg;
  }

  const LINKS = [
    ['GitHub', 'https://github.com/sandera0606',
      'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'],
    ['Website', 'https://shuang.vercel.app/',
      'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z'],
    ['LinkedIn', 'https://www.linkedin.com/in/shuang0616/',
      'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'],
    ['X', 'https://x.com/_shuang0616',
      'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'],
  ];

  root.appendChild(el('div', { class: 'ro-footer' },
    LINKS.map(([label, href, path]) => {
      // rel="noopener noreferrer" so the opened tab gets no handle back on
      // this one — this panel sits on a page holding a live Overleaf session.
      const a = el('a', {
        class: 'ro-footer-link',
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: label,
        'aria-label': label,
      });
      a.appendChild(icon(path));
      return a;
    }),
  ));
  document.documentElement.appendChild(root);

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.action === 'toggleSidebar') {
      toggle();
      sendResponse({ ok: true });
    }
    return false;
  });

  setStatus('Not connected.');
  render();

  server('status').then((res) => {
    if (res.ok && res.data.connected) {
      state.connected = true;
      render();
      loadProject().catch((err) => setStatus(err.message, 'err'));
    }
  });
})();
