/**
 * Save-to-library — fetch resolved RD streams and write them into the ABS
 * watched folder, then trigger an ABS scan.
 *
 * Layout:  /mnt/media2/Audiobooks/<Author>/<Book Title>/<NN - Chapter>.mp3
 * The Audiobookshelf folder is mounted as `/library` inside the addon container
 * (Coolify additional volume).
 */

import { mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import axios from 'axios';

const LIBRARY_ROOT = process.env.AUDIOBOOK_LIBRARY ?? '/library';
const ABS_HOST = process.env.ABS_HOST ?? null;
const ABS_TOKEN = process.env.ABS_TOKEN ?? null;

function safe(name) {
  return (name ?? 'Unknown')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Stream-download `n` tracks in series (sequential to avoid hammering RD CDN).
 * Returns { written: count, target: path } on success.
 */
export async function saveTracksToLibrary({
  author,
  bookTitle,
  tracks,
  onProgress,
}) {
  if (!existsSync(LIBRARY_ROOT)) {
    throw new Error(`Library volume not mounted at ${LIBRARY_ROOT}`);
  }
  const dir = join(LIBRARY_ROOT, safe(author), safe(bookTitle));
  mkdirSync(dir, { recursive: true });

  let written = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const num = String(i + 1).padStart(3, '0');
    const filename = safe(`${num} - ${t.title || `Chapter ${i + 1}`}`) + '.mp3';
    const filePath = join(dir, filename);

    if (existsSync(filePath)) {
      onProgress?.({ index: i, total: tracks.length, filename, skipped: true });
      continue;
    }

    const res = await axios.get(t.url, {
      responseType: 'stream',
      timeout: 0,
      maxRedirects: 5,
    });
    await pipeline(res.data, createWriteStream(filePath));
    written += 1;
    onProgress?.({ index: i, total: tracks.length, filename });
  }

  // Optionally trigger ABS rescan if configured
  if (ABS_HOST && ABS_TOKEN) {
    try {
      const libsRes = await axios.get(`${ABS_HOST}/api/libraries`, {
        headers: { Authorization: `Bearer ${ABS_TOKEN}` },
        timeout: 10_000,
      });
      const lib = libsRes.data?.libraries?.[0];
      if (lib?.id) {
        await axios.post(
          `${ABS_HOST}/api/libraries/${lib.id}/scan`,
          { force: 0 },
          {
            headers: { Authorization: `Bearer ${ABS_TOKEN}` },
            timeout: 10_000,
          }
        );
      }
    } catch (e) {
      console.warn('ABS scan trigger failed:', e.message);
    }
  }

  return { written, target: dir, total: tracks.length };
}
