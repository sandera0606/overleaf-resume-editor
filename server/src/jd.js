/**
 * Turn a job-posting URL into plain text.
 *
 * This is deliberately a plain fetch — no headless browser. Server-rendered
 * boards (Greenhouse, Lever, Ashby, most company career pages) come through
 * fine. Single-page apps and bot-walled sites do not, and the honest answer
 * there is to say so and let the user paste, rather than to return the three
 * words of boilerplate that survived stripping.
 */

const TIMEOUT_MS = 20000;
const MAX_BYTES = 5 * 1024 * 1024;
// Below this, whatever we extracted is boilerplate, not a job description.
const MIN_USEFUL_CHARS = 400;

// Sites known to render client-side or block non-browser traffic. Matching one
// isn't fatal — we still try — but it turns a vague failure into a useful message.
const KNOWN_HOSTILE = [
  [/(^|\.)linkedin\.com$/, 'LinkedIn requires a login and renders postings client-side.'],
  [/myworkdayjobs\.com$/, 'Workday renders postings client-side.'],
  [/(^|\.)indeed\.com$/, 'Indeed blocks automated fetches.'],
  [/(^|\.)glassdoor\.[a-z.]+$/, 'Glassdoor blocks automated fetches.'],
  [/(^|\.)ziprecruiter\.com$/, 'ZipRecruiter blocks automated fetches.'],
];

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/**
 * Prefer the JSON-LD JobPosting block when a site publishes one — it is the
 * description without the chrome, and most ATS platforms emit it for Google
 * Jobs. Falls back to null so the caller can strip the body instead.
 */
function fromJsonLd(html) {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue; // malformed blocks are common; just skip them
    }
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
      const type = node['@type'];
      const isJob = type === 'JobPosting'
        || (Array.isArray(type) && type.includes('JobPosting'));
      if (isJob && typeof node.description === 'string' && node.description.length > MIN_USEFUL_CHARS) {
        const title = [node.title, node.hiringOrganization?.name].filter(Boolean).join(' — ');
        return (title ? `${title}\n\n` : '') + htmlToText(node.description);
      }
    }
  }
  return null;
}

function htmlToText(html) {
  let s = html;

  // Drop anything whose text is never prose.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head']) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }

  // Preserve list structure — requirements are almost always bullets.
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|ul|ol|li|tr|h[1-6]|blockquote)\s*>/gi, '\n');
  s = s.replace(/<h[1-6]\b[^>]*>/gi, '\n\n');

  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);

  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Narrow to the main content region when the page marks one. */
function mainRegion(html) {
  const candidates = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]+(?:id|class)=["'][^"']*(?:job-?description|jobDescription|posting|content-intro)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1].length > 1000) return m[1];
  }
  return html;
}

/**
 * @returns {Promise<{text: string, title: string|null, url: string, source: string}>}
 * @throws  {Error} with a `.status` for anything the caller should show verbatim
 */
async function fetchJobDescription(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw Object.assign(new Error('That does not look like a URL.'), { status: 400 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('Only http and https URLs are supported.'), { status: 400 });
  }

  const hostile = KNOWN_HOSTILE.find(([re]) => re.test(url.hostname))?.[1];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Without a browser-ish UA a good number of boards return a stub page.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `No response in ${TIMEOUT_MS / 1000}s.`
      : `Could not reach that URL (${err.message}).`;
    throw Object.assign(new Error(`${reason}${hostile ? ` ${hostile}` : ''} Paste the description instead.`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw Object.assign(
      new Error(`That page returned ${res.status}. ${hostile || 'The site may be blocking automated fetches.'} Paste the description instead.`),
      { status: 502 },
    );
  }

  const type = res.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
    throw Object.assign(new Error(`That URL returned ${type || 'an unknown type'}, not a web page.`), { status: 415 });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw Object.assign(new Error('That page is unreasonably large.'), { status: 413 });
  }
  const html = buf.toString('utf8');

  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()) || null;

  const structured = fromJsonLd(html);
  const text = structured || htmlToText(mainRegion(html));
  const source = structured ? 'json-ld' : 'html';

  if (text.length < MIN_USEFUL_CHARS) {
    throw Object.assign(
      new Error(
        `Only ${text.length} characters of text came back from that page. `
        + `${hostile || 'It is probably rendered by JavaScript.'} Paste the description instead.`,
      ),
      { status: 422 },
    );
  }

  return { text, title, url: res.url, source };
}

module.exports = { fetchJobDescription, htmlToText, decodeEntities };
