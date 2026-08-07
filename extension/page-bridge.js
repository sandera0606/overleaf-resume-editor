/**
 * MAIN-world bridge for the one thing the content script cannot reach itself.
 *
 * Content scripts share the DOM but not page-world JavaScript: a property React
 * hangs off a DOM node (`__reactFiber$…`) is invisible from the isolated world.
 * The project's root folder id is only available there, so this script runs in
 * the page and answers requests over window.postMessage.
 *
 * Everything else overleaf.js needs — `data-file-id` attributes, the CSRF meta
 * tag — is real DOM and needs no bridge. This is deliberately the smallest
 * possible page-world surface.
 */

(() => {
  const TAG_PAGE = 'resume-optimizer-page';
  const TAG_CONTENT = 'resume-optimizer-content';

  /**
   * Walk up from the file tree's fiber looking for Overleaf's root folder
   * object — the one node carrying both `folders` and `docs` arrays.
   */
  function findRootFolderId() {
    const tree = document.querySelector('[role="tree"]');
    if (!tree) return null;

    const fiberKey = Object.keys(tree).find((k) => k.startsWith('__reactFiber$'));
    if (!fiberKey) return null;

    const seen = new WeakSet();
    const scan = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return null;
      seen.add(node);
      if (node._id && Array.isArray(node.folders) && Array.isArray(node.docs)) return node._id;
      for (const value of Object.values(node)) {
        const hit = scan(value, depth + 1);
        if (hit) return hit;
      }
      return null;
    };

    let fiber = tree[fiberKey];
    for (let hops = 0; fiber && hops < 60; hops++, fiber = fiber.return) {
      const hit = scan(fiber.memoizedProps, 0) || scan(fiber.memoizedState, 0);
      if (hit) return hit;
    }
    return null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.tag !== TAG_CONTENT) return;
    const { id, type } = event.data;
    if (type !== 'ROOT_FOLDER_ID') return;

    let payload;
    try {
      const rootId = findRootFolderId();
      payload = rootId ? { ok: true, rootId } : { ok: false, error: 'Root folder not found in the file tree.' };
    } catch (err) {
      payload = { ok: false, error: err.message };
    }
    window.postMessage({ tag: TAG_PAGE, id, payload }, '*');
  });
})();
