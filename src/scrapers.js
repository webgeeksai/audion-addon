/**
 * Audiobook torrent scrapers.
 * Returns { magnet, infohash, title, size, seeders } objects.
 *
 * Sources:
 *   - AudioBookBay (.lu mirror) — best public audiobook tracker
 *   - 1337x — generic fallback
 *
 * Phase 3: minimal HTML scrape (no Cloudflare bypass yet — we'll plug in
 * Flaresolverr at deploy time if the host fronts ABB through CF).
 */

import axios from 'axios';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const ABB_BASE = process.env.ABB_BASE ?? 'https://audiobookbay.lu';

const http = axios.create({
  timeout: 25_000,
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
  },
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

/** Try every source, dedupe + rank by relevance to the meta */
export async function findReleases(meta) {
  const queries = buildQueries(meta);
  const all = [];
  for (const q of queries) {
    try {
      const hits = await abbSearch(q);
      all.push(...hits);
      if (all.length >= 8) break;
    } catch (e) {
      console.warn('abb query failed:', q, e.message);
    }
  }
  // dedupe by infohash
  const seen = new Map();
  for (const r of all) if (!seen.has(r.infohash)) seen.set(r.infohash, r);

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
    .sort((a, b) => b._score - a._score);
}

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

/** Substring match allowing up to 1 character difference (handles ABB obfuscation). */
function fuzzyContains(haystack, needle) {
  if (needle.length < 4) return haystack.includes(needle);
  if (haystack.includes(needle)) return true;
  // sliding window with edit distance ≤ 1 against the needle length
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

/** Strip noise: parens, language hints, "audiobook" filler */
function cleanForQuery(name = '') {
  return name
    .replace(/\([^)]*\)/g, '') // (Tamil), (Movie Tie-In)
    .replace(/\b(unabridged|audiobook|edition|hindi|tamil|spanish|french|german)\b/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildQueries(meta) {
  const title = cleanForQuery(meta.name ?? '');
  const author = (meta.audion?.authors ?? meta.director ?? [])[0] ?? '';
  const queries = new Set();
  if (title && author) queries.add(`${title} ${author}`);
  if (title) queries.add(title);
  return [...queries];
}

/** Search AudioBookBay → list of release detail page URLs */
async function abbSearch(query) {
  const url = `${ABB_BASE}/?s=${encodeURIComponent(query)}`;
  const { data } = await withRetry(() => http.get(url));
  const html = String(data);

  // Verify this is a search result page (not the front page after a timeout/error).
  // ABB shows "Search results for ..." in the page when there's a query.
  const isSearchPage =
    /Search Results?/i.test(html) || /class="searchPage/.test(html);
  if (!isSearchPage && process.env.DEBUG) {
    console.log('[scrape] WARN: not a search results page for', query);
  }

  const detailLinks = [
    ...new Set(
      [...html.matchAll(/href="(https?:\/\/[^"]*audiobookbay[^"]*\/abss\/[^"]+)"/g)].map(
        (m) => m[1]
      )
    ),
  ].slice(0, 4);

  const results = await Promise.all(
    detailLinks.map((link) =>
      withRetry(() => abbDetail(link)).catch(() => null)
    )
  );
  return results.filter(Boolean);
}

async function abbDetail(detailUrl) {
  const { data } = await http.get(detailUrl);
  const html = String(data);

  // Title: <h1 itemprop="name">…</h1>  (was `<h1 class="postTitle">` in older versions)
  const titleMatch =
    html.match(/<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<h1[^>]*class="[^"]*postTitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
    : detailUrl.split('/').filter(Boolean).pop();

  // Infohash: ABB v3+ puts it in <td>Info Hash:</td><td>...</td>
  const hashMatch =
    html.match(/<td>Info Hash:?<\/td>\s*<td[^>]*>([a-fA-F0-9]{40})<\/td>/i) ||
    html.match(/[Hh]ash[^a-fA-F0-9]{0,20}([a-fA-F0-9]{40})/);
  if (!hashMatch) return null;
  const infohash = hashMatch[1].toLowerCase();

  // Format hint (e.g. "MP3 64kbps", "M4B 96kbps") — used to label streams
  const formatMatch = html.match(/Format:?\s*<\/?[a-z]*>?\s*([A-Za-z0-9 ]+)/i);
  const sizeMatch = html.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i);

  // Trackers — ABB shows a few static UDPs by default; we just attach common ones
  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce',
  ];
  const trMagnet = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  const magnet = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(
    title
  )}${trMagnet}`;

  return {
    magnet,
    infohash,
    title,
    format: formatMatch?.[1]?.trim(),
    size: sizeMatch?.[1],
    seeders: undefined,
  };
}
