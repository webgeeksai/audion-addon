/**
 * Audiobook torrent discovery via Prowlarr.
 *
 * Prowlarr aggregates ~70 trackers (1337x, ThePirateBay, Internet Archive,
 * Nyaa, MyAnonamouse, AudioBookBay etc.) behind a single Newznab-style API
 * with built-in Cloudflare bypass via Flaresolverr. We delegate all the
 * scraping/anti-bot stuff to it instead of poking ABB ourselves (which has
 * been domain-rotating and is unreliable from typical egress points).
 *
 * Config (env):
 *   PROWLARR_URL       e.g. https://prowlarr.webgeeksai.in
 *   PROWLARR_API_KEY   from Prowlarr Settings → General → API Key
 *
 * Exports the same shape callers (streams.js) expect:
 *   { magnet, infohash, title, size, seeders, _score }[]
 */

import axios from 'axios';

const PROWLARR_URL = (process.env.PROWLARR_URL ?? '').replace(/\/$/, '');
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY ?? '';

// Newznab category 3030 = Audio/Audiobook
const AUDIOBOOK_CATEGORY = 3030;

const http = axios.create({
  timeout: 30_000,
  headers: { 'X-Api-Key': PROWLARR_API_KEY },
});

async function withRetry(fn, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Top-level: query Prowlarr → magnets, ranked by relevance. */
export async function findReleases(meta) {
  if (!PROWLARR_URL || !PROWLARR_API_KEY) {
    console.warn('[scrape] PROWLARR_URL/PROWLARR_API_KEY not set — no results');
    return [];
  }

  const queries = buildQueries(meta);
  const seen = new Map(); // dedupe by infohash

  for (const q of queries) {
    let hits = [];
    try {
      hits = await withRetry(() => prowlarrSearch(q));
    } catch (e) {
      console.warn('[scrape] prowlarr query failed:', q, e.message);
      continue;
    }
    for (const h of hits) {
      const release = await prowlarrToRelease(h);
      if (release && !seen.has(release.infohash)) seen.set(release.infohash, release);
    }
    if (seen.size >= 8) break;
  }

  const refTokens = tokensFromMeta(meta);
  if (process.env.DEBUG) {
    console.log('[scrape] refTokens:', [...refTokens]);
    for (const r of seen.values()) {
      const sc = scoreRelevance(r.title, refTokens);
      console.log('[scrape]', sc.toFixed(2), '|', r.title?.slice(0, 60));
    }
  }
  return [...seen.values()]
    .map((r) => ({ ...r, _score: scoreRelevance(r.title, refTokens) }))
    .filter((r) => r._score >= 0.3)
    .sort((a, b) => {
      // Sort by score, then prefer higher seeders, then larger size (longer audiobook).
      if (b._score !== a._score) return b._score - a._score;
      if ((b.seeders ?? 0) !== (a.seeders ?? 0)) return (b.seeders ?? 0) - (a.seeders ?? 0);
      return (b.size ?? 0) - (a.size ?? 0);
    });
}

async function prowlarrSearch(query) {
  const url = `${PROWLARR_URL}/api/v1/search`;
  const { data } = await http.get(url, {
    params: {
      query,
      categories: AUDIOBOOK_CATEGORY,
      type: 'search',
      limit: 50,
    },
  });
  if (!Array.isArray(data)) return [];
  // Filter to torrent protocol only (skip Usenet/NZBs — RD only takes magnets/torrents)
  return data.filter((r) => r.protocol === 'torrent');
}

/** Convert a Prowlarr search hit into a {magnet, infohash, ...} release. */
async function prowlarrToRelease(hit) {
  // Path 1 — guid is itself a magnet (TPB, some others). Cheapest.
  let magnet = null;
  if (typeof hit.guid === 'string' && hit.guid.startsWith('magnet:?')) {
    magnet = hit.guid;
  } else if (typeof hit.magnetUrl === 'string' && hit.magnetUrl.startsWith('magnet:?')) {
    magnet = hit.magnetUrl;
  } else if (typeof hit.magnetUrl === 'string' && hit.magnetUrl.startsWith('http')) {
    // Path 2 — Prowlarr-proxied magnetUrl that 302s to a magnet:?
    magnet = await followMagnetRedirect(hit.magnetUrl);
  }
  // Path 3 — only downloadUrl (returns .torrent file). Skip for now; could
  // be added by parsing bencode infohash and synthesizing a magnet.
  if (!magnet) return null;

  const infohash = extractInfohash(magnet);
  if (!infohash) return null;

  return {
    magnet,
    infohash,
    title: hit.title,
    size: hit.size,
    seeders: hit.seeders,
    indexer: hit.indexer,
  };
}

async function followMagnetRedirect(url) {
  // We expect a 30x with Location: magnet:... — DON'T follow into HTTP redirects.
  try {
    const res = await axios.get(url, {
      maxRedirects: 0,
      timeout: 15_000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const loc = res.headers?.location;
    if (loc && loc.startsWith('magnet:?')) return loc;
  } catch (e) {
    // axios throws on 30x when maxRedirects=0; capture Location from the err
    const loc = e?.response?.headers?.location;
    if (loc && loc.startsWith('magnet:?')) return loc;
  }
  return null;
}

function extractInfohash(magnet) {
  const m = magnet.match(/xt=urn:btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/);
  if (!m) return null;
  return m[1].toLowerCase();
}

// ─── shared helpers (kept from the original ABB scraper) ─────────────────

function tokensFromMeta(meta) {
  const cleanTitle = cleanForQuery(meta.name);
  const author = (meta.audion?.authors ?? meta.director ?? [])[0] ?? '';
  return new Set(
    [cleanTitle, author]
      .join(' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

const STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'audiobook', 'unabridged', 'novel', 'volume', 'book', 'edition',
]);

function scoreRelevance(text, refTokens) {
  if (!text) return 0;
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of refTokens) if (fuzzyContains(t, w)) hits++;
  return refTokens.size > 0 ? hits / refTokens.size : 0;
}

function fuzzyContains(haystack, needle) {
  if (needle.length < 4) return haystack.includes(needle);
  if (haystack.includes(needle)) return true;
  const len = needle.length;
  for (let i = 0; i <= haystack.length - len; i++) {
    const win = haystack.slice(i, i + len);
    if (editDistance(win, needle) <= 1) return true;
  }
  return false;
}

function editDistance(a, b) {
  if (a === b) return 0;
  let diff = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diff++;
    if (diff > 1) return 2;
  }
  return diff;
}

function cleanForQuery(name = '') {
  return name
    // Drop everything after the first colon — usually a subtitle that
    // doesn't appear in torrent names ("Sapiens: A Brief History..." → "Sapiens").
    .split(':')[0]
    // Strip parens AND brackets contents.
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(unabridged|audiobook|edition|hindi|tamil|spanish|french|german|tenth|anniversary)\b/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildQueries(meta) {
  const title = cleanForQuery(meta.name ?? '');
  const authors = meta.audion?.authors ?? meta.director ?? [];
  const author = authors[0] ?? '';
  // Author surname is usually a stronger filter than full name across torrents.
  const surname = author.split(/\s+/).slice(-1)[0] ?? '';

  const queries = new Set();
  // Strongest first: title + author surname (matches "The Martian Weir" etc.)
  if (title && surname) queries.add(`${title} ${surname}`);
  if (title && author && author !== surname) queries.add(`${title} ${author}`);
  // Fallback: title only — broader but may need higher relevance threshold
  if (title) queries.add(title);
  return [...queries];
}
