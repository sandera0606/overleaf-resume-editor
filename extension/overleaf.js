/**
 * Overleaf project-file access, for creating the tailored resume as a real
 * file in the project.
 *
 * Overleaf has no public write API, so this rides the same endpoints the web
 * UI uses, same-origin, with the session cookie and CSRF token already on the
 * page. Two consequences worth knowing:
 *
 *   - Uploading a .tex creates an *editable doc*, not a binary attachment, and
 *     re-uploading the same name returns the same entity id — so re-running for
 *     one job updates that job's file instead of piling up duplicates.
 *   - Reads still go through the project zip (see content.js). Only writing
 *     depends on this file, so if Overleaf changes it, reading survives.
 *
 * Runs in the content script's isolated world and hangs itself off `window`
 * for content.js, which is loaded after it.
 */

(() => {
  if (window.__resumeOptimizerOverleaf) return;

  const api = {};

  api.projectId = () => location.pathname.match(/\/project\/([a-f0-9]{24})/i)?.[1] || null;

  api.csrfToken = () => document.querySelector('meta[name="ol-csrfToken"]')?.content || null;

  /**
   * Resolve a top-level entity by its name in the file tree.
   * The tree renders `data-file-id` / `data-file-type` on each row, which is a
   * far steadier contract than class names.
   */
  api.findEntity = (name, type) => {
    for (const item of document.querySelectorAll('[role="treeitem"]')) {
      if (item.getAttribute('aria-label') !== name) continue;
      const entity = item.querySelector('[data-file-id]');
      if (!entity) continue;
      if (type && entity.getAttribute('data-file-type') !== type) continue;
      return entity.getAttribute('data-file-id');
    }
    return null;
  };

  /**
   * The root folder's id lives only in React's internal state, which is
   * page-world — invisible from this isolated world. page-bridge.js reads it
   * over there and posts it back.
   *
   * Only needed the first time, to create `versions/`; once that folder exists
   * findEntity() resolves it straight from the DOM.
   */
  let bridgeSeq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.tag !== 'resume-optimizer-page') return;
    const resolve = pending.get(event.data.id);
    if (resolve) {
      pending.delete(event.data.id);
      resolve(event.data.payload);
    }
  });

  api.rootFolderId = (timeoutMs = 5000) => {
    const id = ++bridgeSeq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window.postMessage({ tag: 'resume-optimizer-content', id, type: 'ROOT_FOLDER_ID' }, '*');
      setTimeout(() => {
        if (pending.delete(id)) {
          resolve({ ok: false, error: 'The page bridge did not respond. Try reloading the page.' });
        }
      }, timeoutMs);
    }).then((payload) => (payload.ok ? payload.rootId : null));
  };

  api.createFolder = async (name, parentFolderId) => {
    const res = await fetch(`/project/${api.projectId()}/folder`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': api.csrfToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
    });
    if (!res.ok) throw new Error(`Overleaf refused to create the "${name}" folder (${res.status}).`);
    const data = await res.json();
    return data._id || data.id;
  };

  /** Find `name` at the project root, creating it if it isn't there yet. */
  api.ensureFolder = async (name) => {
    const existing = api.findEntity(name, 'folder');
    if (existing) return existing;

    const root = await api.rootFolderId();
    if (!root) {
      throw new Error(
        `No "${name}" folder in this project, and the folder couldn't be created automatically. `
        + `Right-click in Overleaf's file tree, choose "New folder", name it "${name}", then try again.`,
      );
    }
    return api.createFolder(name, root);
  };

  /**
   * Create or overwrite a .tex inside `folderId`.
   * `relativePath` and `name` are both required — without them the endpoint
   * rejects the upload as `invalid_filename`.
   */
  api.writeDoc = async (folderId, filename, text) => {
    const form = new FormData();
    form.append('relativePath', 'null');
    form.append('name', filename);
    form.append('qqfile', new File([text], filename, { type: 'text/x-tex' }));

    const res = await fetch(`/project/${api.projectId()}/upload?folder_id=${encodeURIComponent(folderId)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': api.csrfToken() },
      body: form,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      throw new Error(`Overleaf rejected the write (${res.status}${data?.error ? `: ${data.error}` : ''}).`);
    }
    return data.entity_id;
  };

  /** Best-effort: reveal and open the new file so the user lands on it. */
  api.openFile = async (folderName, filename) => {
    const folderRow = [...document.querySelectorAll('[role="treeitem"]')]
      .find((el) => el.getAttribute('aria-label') === folderName);
    if (folderRow?.getAttribute('aria-expanded') === 'false') {
      folderRow.querySelector('[data-file-id]')?.click();
      await new Promise((r) => setTimeout(r, 350)); // let the tree render children
    }
    const fileRow = [...document.querySelectorAll('[role="treeitem"]')]
      .find((el) => el.getAttribute('aria-label') === filename);
    fileRow?.querySelector('[data-file-id]')?.click();
    return !!fileRow;
  };

  window.__resumeOptimizerOverleaf = api;
})();
