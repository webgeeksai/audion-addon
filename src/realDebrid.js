/**
 * Real-Debrid REST client.
 * Docs: https://api.real-debrid.com/
 *
 * Token is per-user — passed in by the caller.
 * `instantAvailability` was deprecated Nov 2024; we resolve at click time
 * by polling /torrents/info/{id} until status == "downloaded".
 */

import axios from 'axios';

const BASE = 'https://api.real-debrid.com/rest/1.0';

function client(token) {
  return axios.create({
    baseURL: BASE,
    timeout: 30_000,
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function user(token) {
  const { data } = await client(token).get('/user');
  return data;
}

export async function listTorrents(token, { limit = 100, page = 1 } = {}) {
  const { data } = await client(token).get('/torrents', {
    params: { limit, page },
  });
  return data ?? [];
}

export async function torrentInfo(token, id) {
  const { data } = await client(token).get(`/torrents/info/${id}`);
  return data;
}

export async function addMagnet(token, magnet) {
  const params = new URLSearchParams();
  params.set('magnet', magnet);
  const { data } = await client(token).post('/torrents/addMagnet', params);
  return data; // { id, uri }
}

export async function selectFiles(token, id, fileIds = 'all') {
  const params = new URLSearchParams();
  params.set('files', Array.isArray(fileIds) ? fileIds.join(',') : fileIds);
  await client(token).post(`/torrents/selectFiles/${id}`, params);
}

export async function unrestrict(token, link) {
  const params = new URLSearchParams();
  params.set('link', link);
  const { data } = await client(token).post('/unrestrict/link', params);
  return data;
}

/** Wait for a torrent to reach `downloaded` (cached releases finish in <2s). */
export async function waitForDownloaded(token, id, opts = {}) {
  const start = Date.now();
  const maxMs = opts.maxMs ?? 60_000;
  let info = await torrentInfo(token, id);
  while (info.status !== 'downloaded' && Date.now() - start < maxMs) {
    if (info.status === 'error' || info.status === 'magnet_error') {
      throw new Error(`RD torrent error: ${info.status}`);
    }
    await sleep(opts.intervalMs ?? 1500);
    info = await torrentInfo(token, id);
  }
  if (info.status !== 'downloaded') {
    throw new Error(`RD torrent not ready in ${maxMs}ms (status=${info.status})`);
  }
  return info;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const AUDIO_EXT = /\.(mp3|m4b|m4a|aac|flac|opus|ogg|wav)$/i;

/**
 * Take a "downloaded" torrent and resolve all audio files to streaming URLs.
 * Returns ordered tracks (by file path).
 */
export async function tracksFromTorrent(token, info) {
  const audioFiles = info.files
    .filter((f) => f.selected && AUDIO_EXT.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

  // info.links is per *selected* file (positional), in selection order.
  // Build the same order using position in info.files where selected===1.
  const selectedOrder = info.files
    .filter((f) => f.selected)
    .sort((a, b) => a.id - b.id);

  const linkByFileId = new Map();
  selectedOrder.forEach((f, idx) => linkByFileId.set(f.id, info.links[idx]));

  // Parallel unrestrict (RD allows ~250 req/min; 32 in parallel is fine).
  const results = await Promise.all(
    audioFiles.map(async (f) => {
      const link = linkByFileId.get(f.id);
      if (!link) return null;
      try {
        const u = await unrestrict(token, link);
        if (!u.download) return null;
        return {
          url: u.download,
          duration: undefined,
          title: f.path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''),
          bytes: f.bytes,
          path: f.path,
        };
      } catch (e) {
        console.warn('unrestrict failed for', f.path, e.message);
        return null;
      }
    })
  );
  return results
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}
