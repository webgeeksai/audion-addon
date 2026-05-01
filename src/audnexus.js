/**
 * Audnexus client — open API for audiobook metadata, harmonized from Audible.
 * No key required. Public instance: https://api.audnex.us
 */

import axios from 'axios';

const BASE = process.env.AUDNEXUS_BASE ?? 'https://api.audnex.us';

const http = axios.create({
  baseURL: BASE,
  timeout: 12_000,
  headers: { Accept: 'application/json' },
});

/**
 * Audnexus doesn't host its own search — you provide an ASIN.
 * For free-text search we fall back to Audible's public search via a
 * lightweight scrape of audible.com (no key needed). This returns ASINs
 * that Audnexus can then expand.
 */
export async function audibleSearch(query, region = 'us') {
  const url = `https://www.audible.${
    region === 'us' ? 'com' : region
  }/search?keywords=${encodeURIComponent(query)}&overrideBaseCountry=true&ipRedirectOverride=true`;
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  // Each result link looks like /pd/<slug>/<ASIN>?... — pull ASINs
  const html = res.data ?? '';
  const asins = new Set();
  const re = /\/pd\/[^"'<>]+?\/(B0[0-9A-Z]{8})\b/g;
  let m;
  while ((m = re.exec(html)) !== null) asins.add(m[1]);
  return [...asins];
}

export async function getBook(asin, region = 'us') {
  const { data } = await http.get(`/books/${asin}`, { params: { region } });
  return data;
}

export async function getAuthor(asin, region = 'us') {
  const { data } = await http.get(`/authors/${asin}`, { params: { region } });
  return data;
}

export async function getChapters(asin, region = 'us') {
  try {
    const { data } = await http.get(`/books/${asin}/chapters`, { params: { region } });
    return data;
  } catch {
    return null;
  }
}
