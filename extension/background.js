/**
 * Service worker: the only place that talks to the local server.
 *
 * Content scripts can't reach 127.0.0.1 without tripping the page's CSP, so
 * every server call is proxied through here, where host_permissions apply.
 */

const DEFAULT_PORT = 8787;

async function settings() {
  const { port = DEFAULT_PORT, token = null } = await chrome.storage.local.get(['port', 'token']);
  return { port, token, base: `http://127.0.0.1:${port}` };
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const { base, token } = await settings();

  if (auth && !token) {
    throw new Error('Not connected. Start the server and click Connect.');
  }

  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && token ? { 'X-Auth-Token': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach the server on ${base}. Is it running? (npm start in server/)`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

/** Fetch the token from the server's post-startup pairing window. */
async function connect() {
  const { base } = await settings();
  let res;
  try {
    res = await fetch(`${base}/pair`);
  } catch {
    throw new Error(`No server on ${base}. Run "npm start" in the server/ folder first.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Pairing failed.');

  await chrome.storage.local.set({ token: data.token });
  const health = await call('/health', { auth: false });
  return { connected: true, ...health };
}

const actions = {
  connect,
  status: async () => {
    const { token } = await settings();
    const health = await call('/health', { auth: false });
    return { connected: !!token, ...health };
  },
  project: (p) => call('/project', { method: 'POST', body: p }),
  jd: (p) => call('/jd', { method: 'POST', body: p }),
  blocks: (p) => call('/blocks', { method: 'POST', body: p }),
  analyze: (p) => call('/analyze', { method: 'POST', body: p }),
  apply: (p) => call('/apply', { method: 'POST', body: p }),
  archive: (p) => call('/archive', { method: 'POST', body: p }),
  setPort: async ({ port }) => {
    await chrome.storage.local.set({ port: Number(port) || DEFAULT_PORT, token: null });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const action = actions[msg?.action];
  if (!action) {
    sendResponse({ ok: false, error: `Unknown action "${msg?.action}"` });
    return false;
  }
  Promise.resolve(action(msg.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async reply
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!/^https:\/\/[^/]*overleaf\.com\/project\//.test(tab.url || '')) {
    return; // only meaningful inside a project
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
  } catch {
    // Content script not injected yet (e.g. installed after the tab loaded).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
  }
});
