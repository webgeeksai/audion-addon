/**
 * Audion Addon — Stremio-style HTTP service for audiobook discovery + RD streaming.
 *
 * Endpoints:
 *   GET  /manifest.json
 *   GET  /catalog/audiobook/popular.json
 *   GET  /catalog/audiobook/search.json?search=<q>&skip=<n>
 *   GET  /catalog/audiobook/search/search=<q>.json   (Stremio canonical extra-arg form)
 *   GET  /meta/audiobook/<id>.json
 *   GET  /stream/audiobook/<id>.json
 *   GET  /healthz
 */

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { manifest } from './manifest.js';
import { searchCatalog, getMeta } from './catalog.js';
import { resolveStreams } from './streams.js';
import { saveTracksToLibrary } from './library.js';

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'Range', 'X-RD-Token'],
    maxAge: 86400,
  })
);

app.get('/healthz', (c) => c.json({ ok: true }));

app.get('/manifest.json', (c) => c.json(manifest));

function stripJson(s) {
  if (!s) return s;
  const decoded = decodeURIComponent(s);
  return decoded.endsWith('.json') ? decoded.slice(0, -5) : decoded;
}

function parseExtra(extra) {
  if (!extra) return {};
  // Stremio canonical: "search=elon%20musk&skip=20"
  const decoded = decodeURIComponent(extra);
  const params = new URLSearchParams(decoded);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

// /catalog/audiobook/<id>.json  OR  /catalog/audiobook/<id>/<extra>.json
app.get('/catalog/audiobook/*', async (c) => {
  const path = c.req.path;                                // /catalog/audiobook/search/search=elon%20musk.json
  const segments = path.replace('/catalog/audiobook/', '').split('/');
  const id = stripJson(segments[0]);
  const extra = segments.length > 1 ? stripJson(segments[1]) : '';
  const extraQuery = parseExtra(extra);
  const search =
    extraQuery.search ?? c.req.query('search') ?? null;
  const skip = parseInt(extraQuery.skip ?? c.req.query('skip') ?? '0', 10);
  try {
    const metas = await searchCatalog({ id, search, skip });
    return c.json({ metas });
  } catch (e) {
    console.error('catalog error:', e);
    return c.json({ metas: [], error: String(e?.message ?? e) }, 500);
  }
});

app.get('/meta/audiobook/*', async (c) => {
  const path = c.req.path;
  const id = stripJson(path.replace('/meta/audiobook/', ''));
  try {
    const meta = await getMeta(id);
    return meta ? c.json({ meta }) : c.json({ meta: null }, 404);
  } catch (e) {
    console.error('meta error:', e);
    return c.json({ meta: null, error: String(e?.message ?? e) }, 500);
  }
});

app.get('/stream/audiobook/*', async (c) => {
  const path = c.req.path;
  const id = stripJson(path.replace('/stream/audiobook/', ''));
  const rdToken = c.req.query('rd_token') ?? c.req.header('X-RD-Token') ?? null;
  try {
    const streams = await resolveStreams({ id, rdToken });
    return c.json({ streams });
  } catch (e) {
    console.error('stream error:', e);
    return c.json({ streams: [], error: String(e?.message ?? e) }, 500);
  }
});

/**
 * Save-to-library — resolve RD stream + download every track to /library
 * (the Audiobookshelf watched folder) so the book becomes a permanent library
 * entry with offline + progress sync.
 */
app.post('/save/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const rdToken = c.req.query('rd_token') ?? c.req.header('X-RD-Token') ?? null;
  if (!rdToken) {
    return c.json({ error: 'rd_token required' }, 400);
  }
  try {
    const meta = await getMeta(id);
    if (!meta) return c.json({ error: 'unknown book' }, 404);

    const streams = await resolveStreams({ id, rdToken });
    const stream = streams.find((s) => s.audion?.tracks?.length);
    if (!stream) {
      return c.json({ error: 'no resolvable streams to save' }, 422);
    }
    const author = (meta.audion?.authors ?? meta.director ?? ['Unknown'])[0];
    const result = await saveTracksToLibrary({
      author,
      bookTitle: meta.name,
      tracks: stream.audion.tracks,
    });
    return c.json({ ok: true, ...result, meta: { name: meta.name, author } });
  } catch (e) {
    console.error('save error:', e);
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

const PORT = parseInt(process.env.PORT ?? '8787', 10);
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`audion-addon listening on http://0.0.0.0:${info.port}`);
});
