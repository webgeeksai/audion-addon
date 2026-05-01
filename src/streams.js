/**
 * Stream resolver.
 *
 * Strategy (Phase 4 — current):
 *   1. Query RD for the user's existing torrents — match by title fuzzily
 *   2. For each matched torrent, return tracks + RD direct CDN URL
 *
 * Phase 3 (next): if no match in user's RD account, scrape AudioBookBay,
 * push magnet to RD, poll until downloaded, return tracks.
 */

import { getMeta } from './catalog.js';
import { listTorrents, torrentInfo, tracksFromTorrent } from './realDebrid.js';
import { rdCache } from './cache.js';
import { findReleases } from './scrapers.js';
import {
  addMagnet,
  selectFiles,
  waitForDownloaded,
} from './realDebrid.js';

export async function resolveStreams({ id, rdToken }) {
  const meta = await getMeta(id);
  if (!meta) return [];

  if (!rdToken) {
    return [
      {
        name: 'Setup needed',
        title: 'Provide your Real-Debrid API token in addon settings',
        externalUrl: 'https://real-debrid.com/apitoken',
        behaviorHints: { notWebReady: true },
      },
    ];
  }

  const out = [];

  // Strategy 1 — books already in user's RD account
  try {
    const existing = await findInExistingRD(rdToken, meta);
    out.push(...existing);
  } catch (e) {
    console.warn('existing-RD lookup failed:', e.message);
  }

  // Strategy 2 — fresh scrape + add to RD
  if (out.length === 0) {
    try {
      const fresh = await scrapeAndAdd(rdToken, meta);
      out.push(...fresh);
    } catch (e) {
      console.warn('scrape+add failed:', e.message);
      // surface the error to the client as an info stream
      out.push({
        name: 'No streams found',
        title: e.message,
        externalUrl: 'https://real-debrid.com/torrents',
        behaviorHints: { notWebReady: true },
      });
    }
  }

  return out;
}

// Match a torrent's filename loosely against book title + author.
function matches(torrentName, meta) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = [
    ...(meta.audion?.authors ?? []),
    meta.name,
  ]
    .filter(Boolean)
    .map(norm)
    .flatMap((s) => s.split(' '))
    .filter((w) => w.length > 2);
  const t = norm(torrentName);
  // require at least 60% of meta tokens to appear
  let hits = 0;
  for (const w of tokens) if (t.includes(w)) hits++;
  return tokens.length > 0 && hits / tokens.length >= 0.55;
}

async function findInExistingRD(rdToken, meta) {
  const torrents = await listTorrents(rdToken, { limit: 100 });
  const candidates = torrents.filter(
    (t) => t.status === 'downloaded' && matches(t.filename ?? '', meta)
  );
  if (!candidates.length) return [];

  const out = [];
  for (const t of candidates) {
    const cached = await rdCache.get(`${rdToken.slice(-8)}:${t.id}`);
    if (cached) {
      out.push(streamFromTracks(cached, t.filename, true));
      continue;
    }
    try {
      const info = await torrentInfo(rdToken, t.id);
      const tracks = await tracksFromTorrent(rdToken, info);
      if (!tracks.length) continue;
      await rdCache.set(`${rdToken.slice(-8)}:${t.id}`, tracks, 7 * 24 * 3600);
      out.push(streamFromTracks(tracks, t.filename, true));
    } catch (e) {
      console.warn('torrent info/unrestrict failed for', t.id, e.message);
    }
  }
  return out;
}

async function scrapeAndAdd(rdToken, meta) {
  const releases = await findReleases(meta);
  if (!releases.length) {
    throw new Error('No releases found on indexers — try a different title.');
  }

  // Cache per-infohash so a future re-search reuses the resolved tracks instantly
  const out = [];
  for (const r of releases.slice(0, 3)) {
    // already-resolved hash?
    const cached = await rdCache.get(`hash:${r.infohash}`);
    if (cached) {
      out.push(streamFromTracks(cached.tracks, cached.filename ?? r.title, true));
      continue;
    }
    try {
      const { id } = await addMagnet(rdToken, r.magnet);
      await selectFiles(rdToken, id, 'all');
      const info = await waitForDownloaded(rdToken, id, { maxMs: 25_000 });
      const tracks = await tracksFromTorrent(rdToken, info);
      if (tracks.length) {
        await rdCache.set(
          `hash:${r.infohash}`,
          { tracks, filename: info.filename },
          7 * 24 * 3600
        );
        out.push(streamFromTracks(tracks, info.filename, false));
        if (out.length >= 1) break; // ship the first that resolves
      }
    } catch (e) {
      console.warn('release attempt failed:', r.title, e.message);
    }
  }
  return out;
}

function streamFromTracks(tracks, filename, cached) {
  const totalBytes = tracks.reduce((s, t) => s + (t.bytes ?? 0), 0);
  const sizeLabel =
    totalBytes > 0 ? ` · ${Math.round(totalBytes / 1024 / 1024)}MB` : '';
  return {
    name: `${cached ? '⚡' : '☁'} RD${sizeLabel} · ${tracks.length} ${
      tracks.length === 1 ? 'file' : 'files'
    }`,
    title: filename,
    url: tracks[0].url,
    behaviorHints: { bingeGroup: 'audion-rd' },
    audion: {
      cached,
      tracks,
    },
  };
}
