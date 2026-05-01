/**
 * Catalog + meta resolvers.
 *
 * ID format:  audion:gb-<googleBooksVolumeId>
 *
 * Primary metadata: Google Books (free, no key, broad coverage).
 * Optional enrichment: Audnexus chapters/narrator when an ASIN can be inferred.
 */

import { searchBooks as gbSearch, getVolume as gbGetVolume } from './googleBooks.js';
import { searchBooks as olSearch, getWork as olGetWork } from './openLibrary.js';
import { getChapters, getBook as audnexusBook } from './audnexus.js';
import { cache } from './cache.js';

/**
 * Try Google Books first (richer covers + descriptions); fall back to
 * OpenLibrary on any error (429, network, empty result).
 */
async function searchBooks(query, opts) {
  // strategy 1 — Google Books
  try {
    const r = await gbSearch(query, opts);
    if (r.length > 0) return { source: 'gb', volumes: r };
  } catch (e) {
    console.warn('[search] gb failed:', e.message);
  }
  // strategy 2 — OpenLibrary
  try {
    const r = await olSearch(query, opts);
    return { source: 'ol', volumes: r };
  } catch (e) {
    console.warn('[search] ol failed:', e.message);
    return { source: 'none', volumes: [] };
  }
}

async function getVolume(id) {
  // OpenLibrary id ("OL...W") — fetch from OL
  if (id.startsWith('OL')) {
    try {
      return await olGetWork(`/works/${id.replace(/^OL/, '')}`);
    } catch (e) {
      console.warn('[meta] ol failed:', e.message);
      return null;
    }
  }
  // Google Books id — try GB first, fall back to OL by ISBN search if available
  try {
    return await gbGetVolume(id);
  } catch (e) {
    console.warn('[meta] gb failed:', e.message);
    return null;
  }
}

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

function volumeToMeta(v, source = 'gb') {
  if (!v?.id) return null;
  const idPrefix = v.id.startsWith('OL') ? 'ol' : source;
  return {
    id: `audion:${idPrefix}-${v.id}`,
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
      [idPrefix === 'ol' ? 'openLibraryId' : 'googleBooksId']: v.id,
      authors: v.authors,
      publisher: v.publisher,
      isbn: v.industryIdentifiers?.find((x) => x.type === 'ISBN_13' || x.type === 'ISBN')?.identifier,
      rating: v.averageRating ?? v.rating,
    },
  };
}

export async function searchCatalog({ id, search, skip = 0 }) {
  if (id === 'popular') {
    const cacheKey = 'popular-volumes:v2';
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const results = [];
    for (const q of POPULAR_QUERIES) {
      try {
        const { volumes: hits, source } = await searchBooks(q, { limit: 5, langRestrict: 'en' });
        const refTokens = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const ranked = hits
          .map((h) => {
            const text = `${h.title} ${(h.authors ?? []).join(' ')}`.toLowerCase();
            let score = refTokens.filter((t) => text.includes(t)).length;
            if (h.language && h.language !== 'en') score -= 5;
            if (/\([^)]*\)/.test(h.title ?? '')) score -= 1;
            return { h, score };
          })
          .sort((a, b) => b.score - a.score);
        const top = ranked[0]?.h;
        if (top) {
          // pre-cache for later /meta lookups
          await cache.set(`volume:v2:${top.id.startsWith('OL') ? 'ol' : 'gb'}:${top.id}`, top, 7 * 24 * 3600);
          results.push(volumeToMeta(top, source));
        }
      } catch (e) {
        console.warn('popular query failed:', q, e.message);
      }
    }
    await cache.set(cacheKey, results, 6 * 3600);
    return results;
  }

  if (id === 'search' && search?.trim()) {
    const q = search.trim();
    const cacheKey = `search-meta:v2:${q.toLowerCase()}:${skip}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const { volumes: hits, source } = await searchBooks(q, { skip, limit: 20 });
    const metas = hits.map((v) => volumeToMeta(v, source)).filter(Boolean);
    // Pre-cache each volume so /meta/audiobook/{id} can serve without
    // re-fetching the upstream provider (which may be 429-rate-limited).
    await Promise.all(
      hits.map((v) =>
        cache.set(`volume:v2:${v.id.startsWith('OL') ? 'ol' : 'gb'}:${v.id}`, v, 7 * 24 * 3600)
      )
    );
    await cache.set(cacheKey, metas, 24 * 3600);
    return metas;
  }

  return [];
}

export async function getMeta(id) {
  // Match audion:gb-XXX or audion:ol-OLXXXW
  const m = id.match(/^audion:(gb|ol)-(.+)$/);
  if (!m) return null;
  const [, prefix, volId] = m;

  const cacheKey = `volume:v2:${prefix}:${volId}`;
  let volume = await cache.get(cacheKey);
  if (!volume) {
    try {
      volume = await getVolume(volId);
      await cache.set(cacheKey, volume, 7 * 24 * 3600);
    } catch {
      return null;
    }
  }
  const meta = volumeToMeta(volume, prefix);
  if (!meta) return null;

  // Try to enrich with Audnexus chapters via Audible search (best-effort)
  // We use ISBN as a hint. If Audnexus has the book, we get chapter timings.
  // Skipped for now in Phase 1 — added in Phase 2.

  return meta;
}
