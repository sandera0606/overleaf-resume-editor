/**
 * MAIN-world bridge for reviewing rewords inside Overleaf's editor.
 *
 * Content scripts share the DOM but not page JavaScript, so reaching the live
 * CodeMirror 6 instance has to happen here (see manifest "world": "MAIN").
 *
 * Two things this file does that are worth explaining, because both were
 * arrived at by ruling out the obvious approach:
 *
 *  1. Highlighting uses real CM6 decorations, not DOM Ranges. CodeMirror
 *     virtualizes and re-renders; a Range measured against rendered text goes
 *     stale the moment you scroll, and paints nothing. Decorations are
 *     document-position based and survive re-render.
 *
 *  2. The CM6 classes (Decoration, RangeSet, StateEffect) aren't importable
 *     from here, so they're borrowed off live objects: StateEffect from a
 *     scroll effect's constructor, Decoration/RangeSet from a decoration set
 *     already installed in the editor. Every borrow is probed, and failure is
 *     reported rather than thrown — the sidebar falls back to list review.
 *
 * Anchors are matched by TEXT, never by stored offset: accepting one reword
 * shifts every position after it, and re-finding by text is immune to that.
 */

(() => {
  const TAG_PAGE = 'resume-optimizer-page';
  const TAG_CONTENT = 'resume-optimizer-content';

  /** Locate the live EditorView, trying documented shapes then brute force. */
  function findView() {
    for (const sel of ['.cm-content', '.cm-editor', '.cm-scroller']) {
      for (const el of document.querySelectorAll(sel)) {
        const view = el.cmView?.view || el.cmView?.editorView || el._cmView?.view;
        if (view?.state?.doc) return view;
      }
    }
    for (const el of document.querySelectorAll('[class*="cm-"]')) {
      for (const key of Object.keys(el)) {
        if (!key.startsWith('cm') && !key.startsWith('__')) continue;
        const v = el[key]?.view || el[key];
        if (v?.state?.doc && typeof v.dispatch === 'function') return v;
      }
    }
    return null;
  }

  // ------------------------------------------------------- borrowed classes --

  let cm = null; // { Decoration, RangeSet, StateEffect, EditorView }

  function borrowClasses(view) {
    if (cm) return cm;
    const EditorView = view.constructor;

    // StateEffect: any effect instance exposes it as its constructor.
    const StateEffect = EditorView.scrollIntoView(0).constructor;
    if (typeof StateEffect.appendConfig !== 'object') return null;

    // Decoration + RangeSet: pulled off a decoration set the editor already has.
    let Decoration = null;
    let RangeSet = null;
    for (const entry of view.state.facet(EditorView.decorations)) {
      let set;
      try { set = typeof entry === 'function' ? entry(view) : entry; } catch { continue; }
      if (!set || typeof set.iter !== 'function') continue;
      RangeSet = RangeSet || set.constructor;
      const iter = set.iter();
      if (iter.value && typeof iter.value.constructor.mark === 'function') {
        Decoration = iter.value.constructor;
        break;
      }
    }
    if (!Decoration || !RangeSet) return null;

    cm = { Decoration, RangeSet, StateEffect, EditorView };
    return cm;
  }

  // ------------------------------------------------------------- decoration --

  // The span currently under review, as {from, to}. Read by the computed facet.
  let current = null;
  let attached = false;

  function ensureStyle() {
    if (document.getElementById('ro-review-style')) return;
    const style = document.createElement('style');
    style.id = 'ro-review-style';
    style.textContent = `
      .ro-review-hl {
        background: rgba(250, 204, 21, 0.38);
        box-shadow: inset 0 -2px 0 #f59e0b;
        border-radius: 2px;
      }
      .ro-review-hl-done { background: rgba(34, 197, 94, 0.25); box-shadow: inset 0 -2px 0 #16a34a; }
    `;
    document.head.appendChild(style);
  }

  /**
   * Attach the decoration source once.
   *
   * The facet is computed from ['selection'] so that dispatching a selection
   * change re-runs it — that's the update channel, since appendConfig can only
   * add configuration, never replace it. Moving to a suggestion sets the
   * selection anyway, so this costs nothing extra.
   */
  function attach() {
    const view = findView();
    if (!view) return { ok: false, error: 'Could not find the Overleaf editor. Open a .tex file first.' };
    if (attached) return { ok: true, already: true };

    const classes = borrowClasses(view);
    if (!classes) {
      return { ok: false, error: 'This Overleaf build does not expose the editor internals inline review needs.' };
    }

    ensureStyle();
    const { Decoration, RangeSet, StateEffect, EditorView } = classes;

    const source = EditorView.decorations.compute(['selection'], () => {
      if (!current) return RangeSet.empty ?? RangeSet.of([]);
      const cls = current.done ? 'ro-review-hl ro-review-hl-done' : 'ro-review-hl';
      try {
        return RangeSet.of([Decoration.mark({ class: cls }).range(current.from, current.to)]);
      } catch {
        return RangeSet.empty ?? RangeSet.of([]);
      }
    });

    try {
      view.dispatch({ effects: StateEffect.appendConfig.of(source) });
      attached = true;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Could not attach the review layer: ${err.message}` };
    }
  }

  // ------------------------------------------------------------- anchoring --

  /**
   * Find `anchor` in the document, preferring the `occurrence`-th match.
   * Text search rather than a stored offset, so earlier accepted edits can't
   * misalign later ones.
   */
  function locate(view, anchor, occurrence = 0) {
    const text = view.state.doc.toString();
    if (!anchor) return null;

    const hits = [];
    let i = text.indexOf(anchor);
    while (i !== -1 && hits.length <= occurrence + 1) {
      hits.push(i);
      i = text.indexOf(anchor, i + 1);
    }
    if (!hits.length) return null;
    const from = hits[Math.min(occurrence, hits.length - 1)];
    return { from, to: from + anchor.length, matches: hits.length };
  }

  /**
   * Is this position on a commented-out line? Those are hidden blocks, so
   * rewording them changes nothing that renders — such suggestions are dropped
   * rather than shown.
   */
  function inComment(view, pos) {
    return /^\s*%/.test(view.state.doc.lineAt(pos).text);
  }

  function coordsFor(view, from) {
    try {
      const c = view.coordsAtPos(from);
      return c ? { top: c.top, bottom: c.bottom, left: c.left } : null;
    } catch { return null; }
  }

  // -------------------------------------------------------------- handlers --

  const handlers = {
    PING: () => ({ ok: true, found: !!findView(), attached }),

    ATTACH: attach,

    /** Which anchors are actually present (and not commented out)? */
    RESOLVE: ({ anchors = [] }) => {
      const view = findView();
      if (!view) return { ok: false, error: 'Could not find the Overleaf editor.' };
      const seen = new Map();
      const results = anchors.map((anchor) => {
        const occurrence = seen.get(anchor) || 0;
        seen.set(anchor, occurrence + 1);
        const hit = locate(view, anchor, occurrence);
        if (!hit) return { anchor, found: false };
        return { anchor, found: true, occurrence, commented: inComment(view, hit.from) };
      });
      return { ok: true, results };
    },

    /** Highlight one span, scroll it to the middle, and report where it landed. */
    SHOW: ({ anchor, occurrence = 0, done = false }) => {
      const view = findView();
      if (!view) return { ok: false, error: 'Could not find the Overleaf editor.' };
      if (!attached) {
        const res = attach();
        if (!res.ok) return res;
      }

      const hit = locate(view, anchor, occurrence);
      if (!hit) return { ok: false, notFound: true, error: 'That text is no longer in the document.' };

      current = { from: hit.from, to: hit.to, done };
      try {
        view.dispatch({
          // Setting the selection is what re-runs the computed facet.
          selection: { anchor: hit.from, head: hit.to },
          effects: cm.EditorView.scrollIntoView(hit.from, { y: 'center' }),
          scrollIntoView: false,
        });
      } catch (err) {
        return { ok: false, error: `Could not move to that text: ${err.message}` };
      }

      return { ok: true, from: hit.from, to: hit.to, coords: coordsFor(view, hit.from) };
    },

    /** Where is the current highlight now? Used to keep the toolbar pinned. */
    COORDS: () => {
      const view = findView();
      if (!view || !current) return { ok: false };
      return { ok: true, coords: coordsFor(view, current.from) };
    },

    /** Replace the anchored span, verifying the text still matches first. */
    ACCEPT: ({ anchor, occurrence = 0, replacement }) => {
      const view = findView();
      if (!view) return { ok: false, error: 'Could not find the Overleaf editor.' };

      const hit = locate(view, anchor, occurrence);
      if (!hit) return { ok: false, notFound: true, error: 'That text is no longer in the document.' };

      const actual = view.state.doc.sliceString(hit.from, hit.to);
      if (actual !== anchor) {
        return { ok: false, error: 'The text changed underneath this suggestion. Skip it and re-analyze.' };
      }

      try {
        view.dispatch({
          changes: { from: hit.from, to: hit.to, insert: replacement },
          selection: { anchor: hit.from, head: hit.from + replacement.length },
          scrollIntoView: false,
        });
      } catch (err) {
        return { ok: false, error: `Could not apply the edit: ${err.message}` };
      }

      current = { from: hit.from, to: hit.from + replacement.length, done: true };
      return { ok: true, from: hit.from, to: hit.from + replacement.length };
    },

    /** Drop the highlight (review finished or cancelled). */
    CLEAR: () => {
      const view = findView();
      current = null;
      if (view) {
        try {
          view.dispatch({ selection: { anchor: view.state.selection.main.anchor } });
        } catch { /* the highlight simply lingers until the next dispatch */ }
      }
      return { ok: true };
    },

    /** Full document text, so the panel can re-anchor against what's really there. */
    READ: () => {
      const view = findView();
      if (!view) return { ok: false, error: 'Could not find the Overleaf editor.' };
      return { ok: true, text: view.state.doc.toString() };
    },
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.tag !== TAG_CONTENT) return;
    const handler = handlers[msg.type];
    if (!handler) return; // another bridge owns this message type

    let payload;
    try {
      payload = handler(msg.payload || {});
    } catch (err) {
      payload = { ok: false, error: err.message };
    }
    window.postMessage({ tag: TAG_PAGE, id: msg.id, payload }, '*');
  });

  // Keep the toolbar glued to the text while the user scrolls.
  const notifyScroll = () => {
    if (!current) return;
    window.postMessage({ tag: TAG_PAGE, type: 'SCROLLED' }, '*');
  };
  document.addEventListener('scroll', notifyScroll, { capture: true, passive: true });

  window.postMessage({ tag: TAG_PAGE, type: 'REVIEW_READY' }, '*');
})();
