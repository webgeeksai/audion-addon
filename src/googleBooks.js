/**
 * Google Books client — free public API, no key needed for low volumes.
 * Used as the primary metadata source for catalog/search/meta.
 */

import axios from 'axios';

const http = axios.create({
  baseURL: 'https://www.googleapis.com/books/v1',
  timeout: 10_000,
  headers: { Accept: 'application/json' },
  params: process.env.GOOGLE_BOOKS_API_KEY
    ? { key: process.env.GOOGLE_BOOKS_API_KEY }
    : {},
});

export async function searchBooks(query, { skip = 0, limit = 20, langRestrict = 'en' } = {}) {
  const { data } = await http.get('/volumes', {
    params: {
      q: query,
      startIndex: skip,
      maxResults: Math.min(limit, 40),
      printType: 'books',
      orderBy: 'relevance',
      langRestrict,
    },
  });
  return (data.items ?? []).map(normalizeVolume).filter(Boolean);
}

export async function getVolume(id) {
  const { data } = await http.get(`/volumes/${id}`);
  return normalizeVolume(data);
}

function normalizeVolume(v) {
  if (!v?.id || !v.volumeInfo) return null;
  const vi = v.volumeInfo;
  // Best cover (zoom 1 ≈ thumbnail, force https + crop scale params)
  let cover = vi.imageLinks?.extraLarge
    ?? vi.imageLinks?.large
    ?? vi.imageLinks?.medium
    ?? vi.imageLinks?.thumbnail
    ?? null;
  if (cover) cover = cover.replace(/^http:/, 'https:').replace('&edge=curl', '');
  return {
    id: v.id,
    title: vi.title,
    subtitle: vi.subtitle,
    authors: vi.authors ?? [],
    publisher: vi.publisher,
    publishedYear: vi.publishedDate?.slice(0, 4),
    description: vi.description,
    pageCount: vi.pageCount,
    cover,
    categories: vi.categories ?? [],
    language: vi.language,
    industryIdentifiers: vi.industryIdentifiers ?? [], // ISBNs
    averageRating: vi.averageRating,
    ratingsCount: vi.ratingsCount,
  };
}
