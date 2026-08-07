/**
 * One JSON POST helper shared by every HTTP provider.
 *
 * Its main job beyond the fetch itself is redaction: provider errors routinely
 * echo the request back, and an unredacted echo would put the user's API key
 * into server logs and into the extension's status bar.
 */

const DEFAULT_TIMEOUT_MS = 180000;

// Matches the key shapes the supported providers issue, plus a generic
// long-opaque-token fallback.
const KEY_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{10,}/g,
];

/** Strip anything that looks like a credential out of text bound for a log or a UI. */
function redact(text) {
  let out = String(text ?? '');
  for (const re of KEY_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** Pull the most useful message out of a provider's error envelope. */
function errorMessage(status, payload, raw) {
  const candidate = payload?.error?.message
    ?? payload?.error?.status
    ?? payload?.message
    ?? (Array.isArray(payload?.error) ? payload.error[0]?.message : null)
    ?? raw;
  const text = redact(candidate || '').trim();
  return text ? `${status}: ${text.slice(0, 400)}` : `HTTP ${status}`;
}

async function postJson(url, body, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, label = 'Provider' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${label} did not respond within ${timeoutMs / 1000}s.`);
    }
    throw new Error(`Could not reach ${label}: ${redact(err.message)}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* keep raw for the error path */ }

  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' Check the API key in server/config.json (or the matching environment variable).'
      : '';
    throw new Error(`${label} error ${errorMessage(res.status, payload, raw)}.${hint}`);
  }
  if (!payload) throw new Error(`${label} returned a non-JSON response.`);

  return payload;
}

module.exports = { postJson, redact };
