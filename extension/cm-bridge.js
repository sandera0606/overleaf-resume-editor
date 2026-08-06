/**
 * MAIN-world bridge to Overleaf's CodeMirror 6 instance.
 *
 * Content scripts run in an isolated world and cannot see page JavaScript
 * objects, so this file is injected into the page world (see manifest
 * "world": "MAIN") and talks to the content script over window.postMessage.
 *
 * Reaching the EditorView through `.cmView` is CodeMirror internals rather
 * than public API, so every access is probed and failure is reported rather
 * than thrown — the sidebar degrades to read-only instead of breaking.
 */

(() => {
  const TAG_PAGE = 'resume-optimizer-page';
  const TAG_CONTENT = 'resume-optimizer-content';

  /** Locate the live EditorView, trying the documented shapes then brute force. */
  function findView() {
    const probes = ['.cm-content', '.cm-editor', '.cm-scroller'];
    for (const sel of probes) {
      for (const el of document.querySelectorAll(sel)) {
        const view = el.cmView?.view || el.cmView?.editorView || el._cmView?.view;
        if (view?.state?.doc) return view;
      }
    }
    // Last resort: some builds hang the view off an ancestor under another key.
    for (const el of document.querySelectorAll('[class*="cm-"]')) {
      for (const key of Object.keys(el)) {
        if (!key.startsWith('cm') && !key.startsWith('__')) continue;
        const v = el[key]?.view || el[key];
        if (v?.state?.doc && typeof v.dispatch === 'function') return v;
      }
    }
    return null;
  }

  function read() {
    const view = findView();
    if (!view) return { ok: false, error: 'Could not find the Overleaf editor. Open a .tex file first.' };
    return { ok: true, text: view.state.doc.toString() };
  }

  /**
   * Replace the whole document in a single transaction, so the edit is one
   * undo step and flows through Overleaf's normal sync path.
   */
  function write({ text, expected }) {
    const view = findView();
    if (!view) return { ok: false, error: 'Could not find the Overleaf editor.' };

    const current = view.state.doc.toString();
    if (typeof expected === 'string' && current !== expected) {
      return {
        ok: false,
        error: 'The file changed in the editor since it was analyzed. Re-run Analyze so suggestions match the current text.',
        drift: true,
      };
    }
    if (current === text) return { ok: true, unchanged: true };

    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        // Keep the viewport stable rather than jumping to the end.
        selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) },
        scrollIntoView: false,
      });
      return { ok: true, method: 'dispatch' };
    } catch (err) {
      // Fallback: CodeMirror handles beforeinput, so execCommand still works.
      try {
        view.focus();
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        const inserted = document.execCommand('insertText', false, text);
        if (!inserted) throw new Error('execCommand rejected the insert');
        return { ok: true, method: 'execCommand' };
      } catch (fallbackErr) {
        return { ok: false, error: `Could not write to the editor: ${err.message} / ${fallbackErr.message}` };
      }
    }
  }

  const handlers = {
    PING: () => ({ ok: true, found: !!findView() }),
    READ: read,
    WRITE: write,
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.tag !== TAG_CONTENT) return;

    const handler = handlers[msg.type];
    let payload;
    try {
      payload = handler
        ? handler(msg.payload || {})
        : { ok: false, error: `Unknown bridge command "${msg.type}"` };
    } catch (err) {
      payload = { ok: false, error: err.message };
    }
    window.postMessage({ tag: TAG_PAGE, id: msg.id, payload }, '*');
  });

  window.postMessage({ tag: TAG_PAGE, type: 'READY' }, '*');
})();
