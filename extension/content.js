/**
 * Sidebar UI injected into an Overleaf project page.
 *
 * All rendering uses textContent rather than innerHTML: suggestion text comes
 * from a language model and lands inside a privileged extension context, so it
 * is treated as untrusted throughout.
 */

(() => {
  if (window.__resumeOptimizerLoaded) return;
  window.__resumeOptimizerLoaded = true;

  const TAG_PAGE = 'resume-optimizer-page';
  const TAG_CONTENT = 'resume-optimizer-content';

  // ---------------------------------------------------------------- bridge --

  let bridgeSeq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.tag !== TAG_PAGE) return;
    const { id, payload } = event.data;
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
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: 'No response from the extension background worker.' });
        }
      });
    });
  }

  // ----------------------------------------------------------------- state --

  const state = {
    connected: false,
    sources: {},        // filename -> latex
    files: [],          // inventory from the server
    selected: null,     // filename being tailored
    analyzedSource: '', // exact text the suggestions were generated against
    suggestions: [],
    accepted: new Set(),
    summary: '',
    keywords: [],
  };

  // -------------------------------------------------------------- elements --

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
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

  function toggle(force) {
    const show = force ?? !root.classList.contains('ro-open');
    root.classList.toggle('ro-open', show);
    document.body.classList.toggle('ro-shifted', show);
  }

  // ------------------------------------------------------------ zip loading --

  function projectId() {
    const m = location.pathname.match(/\/project\/([a-f0-9]{24})/i);
    return m ? m[1] : null;
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000; // chunked to avoid blowing the argument limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function loadProject() {
    const id = projectId();
    if (!id) throw new Error('Could not read the project id from the URL.');

    setStatus('Downloading project…');
    // Same-origin, so the session cookie rides along automatically.
    const res = await fetch(`/project/${id}/download/zip`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Overleaf refused the project download (${res.status}).`);
    const buf = await res.arrayBuffer();

    setStatus('Parsing LaTeX…');
    const out = await server('project', { zipBase64: toBase64(buf) });
    if (!out.ok) throw new Error(out.error);

    state.files = out.data.files;
    state.sources = out.data.sources;

    // Identify the open file by matching editor text against the zip contents,
    // which is far more durable than scraping Overleaf's file-tree DOM.
    const live = await bridge('READ');
    if (live.ok) {
      const match = Object.entries(state.sources).find(([, src]) => src === live.text);
      if (match) state.selected = match[0];
    }
    if (!state.selected) {
      const best = state.files.slice().sort((a, b) => b.blocks - a.blocks)[0];
      state.selected = best?.name || null;
    }
    render();
    setStatus(`Loaded ${state.files.length} .tex file(s).`, 'ok');
  }

  // -------------------------------------------------------------- rendering --

  function renderConnect() {
    return el('div', { class: 'ro-step' }, [
      el('p', { class: 'ro-hint', text: 'Start the local server, then connect. Pairing is open for a few minutes after the server starts.' }),
      el('button', {
        class: 'ro-btn ro-primary',
        onclick: async (e) => {
          e.target.disabled = true;
          setStatus('Connecting…');
          const res = await server('connect');
          e.target.disabled = false;
          if (!res.ok) return setStatus(res.error, 'err');
          state.connected = true;
          setStatus(`Connected. Archive: ${res.data.archiveDir}`, 'ok');
          render();
          loadProject().catch((err) => setStatus(err.message, 'err'));
        },
        text: 'Connect to local server',
      }),
    ]);
  }

  function renderFilePicker() {
    const select = el('select', {
      class: 'ro-select',
      onchange: (e) => { state.selected = e.target.value; render(); },
    });
    for (const f of state.files) {
      const opt = el('option', { value: f.name });
      opt.textContent = `${f.name} — ${f.active} shown, ${f.hidden} hidden`;
      if (f.name === state.selected) opt.selected = true;
      select.appendChild(opt);
    }
    return el('div', { class: 'ro-step' }, [
      el('label', { class: 'ro-label', text: 'Resume file' }),
      select,
      el('button', {
        class: 'ro-btn ro-ghost',
        onclick: () => loadProject().catch((err) => setStatus(err.message, 'err')),
        text: 'Reload from Overleaf',
      }),
    ]);
  }

  const jdInput = el('textarea', { class: 'ro-textarea', rows: '9', placeholder: 'Paste the job description here…' });
  const labelInput = el('input', { class: 'ro-input', type: 'text', placeholder: 'e.g. Acme — Backend Engineer' });

  function renderAnalyze() {
    return el('div', { class: 'ro-step' }, [
      el('label', { class: 'ro-label', text: 'Job description' }),
      jdInput,
      el('label', { class: 'ro-label', text: 'Label (for the archive filename)' }),
      labelInput,
      el('button', {
        class: 'ro-btn ro-primary',
        onclick: async (e) => {
          const jd = jdInput.value.trim();
          if (!jd) return setStatus('Paste a job description first.', 'err');
          if (!state.selected) return setStatus('Pick a resume file first.', 'err');

          e.target.disabled = true;
          setStatus('Asking Claude… this usually takes 20–60s.');
          const source = state.sources[state.selected];
          const res = await server('analyze', { jobDescription: jd, source, filename: state.selected });
          e.target.disabled = false;

          if (!res.ok) return setStatus(res.error, 'err');
          state.suggestions = res.data.suggestions;
          state.summary = res.data.summary;
          state.keywords = res.data.keywords || [];
          state.analyzedSource = source;
          state.accepted = new Set(state.suggestions.map((s) => s.id)); // opt-out, not opt-in
          render();
          setStatus(`${state.suggestions.length} suggestions. Review, then apply.`, 'ok');
        },
        text: 'Analyze against this job',
      }),
    ]);
  }

  const TYPE_LABEL = {
    reword: 'reword',
    block_comment: 'hide',
    block_uncomment: 'show',
    block_move: 'move',
  };

  function renderSuggestion(s) {
    const box = el('input', { class: 'ro-check', type: 'checkbox' });
    box.checked = state.accepted.has(s.id);
    box.addEventListener('change', () => {
      if (box.checked) state.accepted.add(s.id);
      else state.accepted.delete(s.id);
      updateApplyCount();
    });

    const detail = el('div', { class: 'ro-detail' });
    if (s.type === 'reword') {
      detail.appendChild(el('div', { class: 'ro-before', text: s.anchor || '' }));
      detail.appendChild(el('div', { class: 'ro-after', text: s.replacement || '' }));
    } else {
      const target = el('div', { class: 'ro-target' });
      target.textContent = s.blockId + (s.afterBlockId ? ` → after ${s.afterBlockId}` : '');
      detail.appendChild(target);
    }

    return el('label', { class: 'ro-sugg' }, [
      box,
      el('div', { class: 'ro-sugg-main' }, [
        el('div', { class: 'ro-sugg-head' }, [
          el('span', { class: `ro-badge ro-badge-${s.type}`, text: TYPE_LABEL[s.type] || s.type }),
          el('span', { class: 'ro-conf', text: s.confidence || '' }),
        ]),
        detail,
        el('div', { class: 'ro-why', text: s.rationale || '' }),
      ]),
    ]);
  }

  let applyBtn = null;
  function updateApplyCount() {
    if (applyBtn) applyBtn.textContent = `Apply ${state.accepted.size} to Overleaf`;
  }

  function renderResults() {
    if (!state.suggestions.length) return null;

    const list = el('div', { class: 'ro-list' }, state.suggestions.map(renderSuggestion));

    applyBtn = el('button', {
      class: 'ro-btn ro-primary',
      onclick: async (e) => {
        const accepted = state.suggestions.filter((s) => state.accepted.has(s.id));
        if (!accepted.length) return setStatus('Nothing selected.', 'err');

        e.target.disabled = true;
        setStatus('Applying…');
        const res = await server('apply', { source: state.analyzedSource, suggestions: accepted });
        if (!res.ok) { e.target.disabled = false; return setStatus(res.error, 'err'); }

        const { text, results } = res.data;
        const failed = results.filter((r) => r.status === 'failed');

        // Only write if the editor still holds the text we analyzed.
        const write = await bridge('WRITE', { text, expected: state.analyzedSource });
        e.target.disabled = false;

        if (!write.ok) return setStatus(write.error, 'err');

        state.sources[state.selected] = text;
        state.analyzedSource = text;

        const archived = await server('archive', {
          label: labelInput.value.trim() || state.selected,
          tex: text,
          jobDescription: jdInput.value,
          meta: { file: state.selected, applied: results.filter((r) => r.status === 'applied').length },
        });

        const parts = [`Applied ${results.filter((r) => r.status === 'applied').length}`];
        if (failed.length) parts.push(`${failed.length} failed`);
        if (archived.ok) parts.push(`archived as ${archived.data.name}.tex`);
        setStatus(parts.join(' · '), failed.length ? 'warn' : 'ok');

        if (failed.length) {
          list.prepend(el('div', { class: 'ro-failed' },
            failed.map((f) => el('div', { class: 'ro-failed-row', text: `${f.id}: ${f.reason}` }))));
        }
      },
    });
    updateApplyCount();

    return el('div', { class: 'ro-step' }, [
      state.summary ? el('p', { class: 'ro-summary', text: state.summary }) : null,
      state.keywords.length
        ? el('div', { class: 'ro-keywords' }, [
            el('span', { class: 'ro-label', text: 'Missing keywords' }),
            el('div', { class: 'ro-chips' }, state.keywords.map((k) => el('span', { class: 'ro-chip', text: k }))),
          ])
        : null,
      el('div', { class: 'ro-actions' }, [
        el('button', { class: 'ro-btn ro-ghost', text: 'All', onclick: () => { state.suggestions.forEach((s) => state.accepted.add(s.id)); render(); } }),
        el('button', { class: 'ro-btn ro-ghost', text: 'None', onclick: () => { state.accepted.clear(); render(); } }),
      ]),
      list,
      applyBtn,
    ]);
  }

  function render() {
    body.textContent = '';
    if (!state.connected) {
      body.appendChild(renderConnect());
      return;
    }
    if (state.files.length) body.appendChild(renderFilePicker());
    body.appendChild(renderAnalyze());
    const results = renderResults();
    if (results) body.appendChild(results);
  }

  // ------------------------------------------------------------------ boot --

  root.appendChild(el('div', { class: 'ro-header' }, [
    el('span', { class: 'ro-title', text: 'Resume Optimizer' }),
    el('button', { class: 'ro-close', text: '×', onclick: () => toggle(false) }),
  ]));
  root.appendChild(statusBar);
  root.appendChild(body);
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

  // If the server is already paired from a previous session, pick up where we left off.
  server('status').then((res) => {
    if (res.ok && res.data.connected) {
      state.connected = true;
      render();
      setStatus('Connected.', 'ok');
      loadProject().catch((err) => setStatus(err.message, 'err'));
    }
  });
})();
