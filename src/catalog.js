/**
 * Catalog + meta resolvers.
 *
 * ID format:  audion:gb-<googleBooksVolumeId>
 *
 * Primary metadata: Google Books (free, no key, broad coverage).
 * Optional enrichment: Audnexus chapters/narrator when an ASIN can be inferred.
 */

import { searchBooks, getVolume } from './googleBooks.js';
import { getChapters, getBook as audnexusBook } from './audnexus.js';
import { cache } from './cache.js';

const POPULAR_QUERIES = [
  'project hail mary andy weir',
  'elon musk walter isaacson',
  'atomic habits english james clear', // bias toward English edition
  'the psychology of money morgan housel',
  'tomorrow and tomorrow tomorrow gabrielle zevin',
  'the anxious generation jonathan haidt',
  'lessons in chemistry bonnie garmus',
  'fourth wing rebecca yarros',
];

function volumeToMeta(v) {
  if (!v?.id) return null;
  return {
    id: `audion:gb-${v.id}`,
    type: 'audiobook',
    name: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
    poster: v.cover,
    posterShape: 'square',
    background: v.cover,
    description: v.description,
    releaseInfo: v.publishedYear,
    director: v.authors,
    cast: [],
    genres: v.categories,
    audion: {
      googleBooksId: v.id,
      authors: v.authors,
      publisher: v.publisher,
      isbn: v.industryIdentifiers?.find((x) => x.type === 'ISBN_13')?.identifier,
      rating: v.averageRating,
    },
  };
}

export async function searchCatalog({ id, search, skip = 0 }) {
  if (id === 'popular') {
    const cacheKey = 'popular-volumes';
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const results = [];
    for (const q of POPULAR_QUERIES) {
      try {
        const hits = await searchBooks(q, { limit: 5, langRestrict: 'en' });
        // pick the best English hit:
        // - require language === 'en'
        // - prefer original title without parenthetical hints (Tamil), (Hindi)
        // - bias by author match
        const refTokens = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const ranked = hits
          .map((h) => {
            const text = `${h.title} ${(h.authors ?? []).join(' ')}`.toLowerCase();
            let score = refTokens.filter((t) => text.includes(t)).length;
            if (h.language && h.language !== 'en') score -= 5;
            if (/\([^)]*\)/.test(h.title ?? '')) score -= 1; // demote (Tamil) etc
            return { h, score };
          })
          .sort((a, b) => b.score - a.score);
        if (ranked[0]?.h) results.push(volumeToMeta(ranked[0].h));
      } catch {}
    }
    await cache.set(cacheKey, results, 6 * 3600);
    return results;
  }

  if (id === 'search' && search?.trim()) {
    const q = search.trim();
    const cacheKey = `search-meta:${q.toLowerCase()}:${skip}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const hits = await searchBooks(q, { skip, limit: 20 });
    const metas = hits.map(volumeToMeta).filter(Boolean);
    await cache.set(cacheKey, metas, 24 * 3600);
    return metas;
  }

  return [];
}

export async function getMeta(id) {
  const m = id.match(/^audion:gb-(.+)$/);
  if (!m) return null;
  const volId = m[1];

  const cacheKey = `volume:${volId}`;
  let volume = await cache.get(cacheKey);
  if (!volume) {
    try {
      volume = await getVolume(volId);
      await cache.set(cacheKey, volume, 7 * 24 * 3600);
    } catch {
      return null;
    }
  }
  const meta = volumeToMeta(volume);
  if (!meta) return null;

  // Try to enrich with Audnexus chapters via Audible search (best-effort)
  // We use ISBN as a hint. If Audnexus has the book, we get chapter timings.
  // Skipped for now in Phase 1 — added in Phase 2.

  return meta;
}
