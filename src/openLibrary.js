/**
 * OpenLibrary fallback — free, no API key, no rate limits.
 * Used when Google Books 429s or returns nothing.
 *   /search.json?q=... → docs[]
 *   /works/OL...W.json → work details
 */

import axios from 'axios';

const http = axios.create({
  baseURL: 'https://openlibrary.org',
  timeout: 12_000,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'audion-addon/0.1 (https://github.com/webgeeksai/audion-addon)',
  },
});

export async function searchBooks(query, { skip = 0, limit = 20 } = {}) {
  const { data } = await http.get('/search.json', {
    params: {
      q: query,
      offset: skip,
      limit: Math.min(limit, 40),
      fields: 'key,title,author_name,first_publish_year,cover_i,isbn,publisher,subject',
    },
  });
  return (data.docs ?? []).map(normalizeDoc).filter(Boolean);
}

export async function getWork(workKey) {
  const { data } = await http.get(`${workKey}.json`);
  return normalizeWork(data);
}

function normalizeDoc(d) {
  if (!d?.key) return null;
  // d.key is "/works/OL12345W"
  const id = d.key.replace('/works/', 'OL');
  return {
    id,
    title: d.title,
    authors: d.author_name ?? [],
    publisher: (d.publisher ?? [])[0],
    publishedYear: d.first_publish_year ? String(d.first_publish_year) : undefined,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    categories: (d.subject ?? []).slice(0, 6),
    industryIdentifiers: (d.isbn ?? []).slice(0, 3).map((i) => ({ type: 'ISBN', identifier: i })),
    description: undefined,
    rating: undefined,
  };
}

function normalizeWork(w) {
  if (!w?.key) return null;
  const id = w.key.replace('/works/', 'OL');
  return {
    id,
    title: w.title,
    description: typeof w.description === 'string' ? w.description : w.description?.value,
    authors: (w.authors ?? []).map((a) => a.author?.name).filter(Boolean),
    publishedYear: w.first_publish_date?.slice(0, 4),
    cover: w.covers?.[0]
      ? `https://covers.openlibrary.org/b/id/${w.covers[0]}-L.jpg`
      : null,
    categories: (w.subjects ?? []).slice(0, 6),
    industryIdentifiers: [],
  };
}
