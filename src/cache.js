/**
 * SQLite-backed JSON cache. Single table, key→value with expires_at.
 * Switch to Postgres when we deploy multi-instance.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.CACHE_DB ?? './data/cache.db';
mkdirSync(dirname(path), { recursive: true });

const db = new Database(path);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at);

  CREATE TABLE IF NOT EXISTS rd_links (
    infohash TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const stmtGet = db.prepare(`SELECT value, expires_at FROM kv WHERE key = ?`);
const stmtSet = db.prepare(
  `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
);
const stmtDel = db.prepare(`DELETE FROM kv WHERE key = ?`);

export const cache = {
  async get(key) {
    const row = stmtGet.get(key);
    if (!row) return null;
    if (row.expires_at < nowSec()) {
      stmtDel.run(key);
      return null;
    }
    return JSON.parse(row.value);
  },
  async set(key, value, ttlSec) {
    stmtSet.run(key, JSON.stringify(value), nowSec() + ttlSec);
  },
  async remove(key) {
    stmtDel.run(key);
  },
};

const stmtRDGet = db.prepare(
  `SELECT payload, expires_at FROM rd_links WHERE infohash = ?`
);
const stmtRDSet = db.prepare(
  `INSERT INTO rd_links (infohash, payload, expires_at) VALUES (?, ?, ?)
   ON CONFLICT(infohash) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`
);

export const rdCache = {
  async get(hash) {
    const row = stmtRDGet.get(hash);
    if (!row) return null;
    if (row.expires_at < nowSec()) return null;
    return JSON.parse(row.payload);
  },
  async set(hash, payload, ttlSec) {
    stmtRDSet.run(hash, JSON.stringify(payload), nowSec() + ttlSec);
  },
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
