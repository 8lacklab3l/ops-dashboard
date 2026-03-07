'use strict';

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

const app     = express();
const PORT    = process.env.PORT    || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'pentest.db');

// ─── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database(DB_FILE);

// WAL mode for concurrent readers + one writer
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  -- Per-record tables for hosts, networks, credentials, findings, activity
  -- Each row is one record; data stored as JSON blob per record
  CREATE TABLE IF NOT EXISTS hosts (
    id       TEXT    PRIMARY KEY,
    data     TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS networks (
    id       TEXT    PRIMARY KEY,
    data     TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    id       TEXT    PRIMARY KEY,
    data     TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS findings (
    id       TEXT    PRIMARY KEY,
    data     TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity (
    id       TEXT    PRIMARY KEY,
    data     TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );

  -- Single-row tables for op metadata and map positions
  CREATE TABLE IF NOT EXISTS meta (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_positions (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );
`);

// Seed defaults on first run
const now = Date.now();
db.prepare('INSERT OR IGNORE INTO meta (id, data, modified) VALUES (1, ?, ?)')
  .run(JSON.stringify({ opName:'Unnamed Op', scope:'', notes:'', targetPrefix:'',
                        created:now, modified:now }), now);
db.prepare('INSERT OR IGNORE INTO map_positions (id, data, modified) VALUES (1, ?, ?)')
  .run('{}', now);

// ─── HELPERS ───────────────────────────────────────────────────────────────────
const RECORD_TABLES = ['hosts', 'networks', 'credentials', 'findings', 'activity'];

function tableModified(table) {
  const row = db.prepare(`SELECT MAX(modified) AS m FROM "${table}"`).get();
  return row?.m ?? 0;
}

function allRecords(table) {
  return db.prepare(`SELECT data FROM "${table}" ORDER BY modified ASC`)
    .all()
    .map(r => JSON.parse(r.data));
}

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ─── API ────────────────────────────────────────────────────────────────────────

/**
 * GET /api/ping
 * Returns per-table last-modified timestamps.
 * Clients compare against their cached versions to decide what to fetch.
 */
app.get('/api/ping', (req, res) => {
  res.json({
    hosts:        tableModified('hosts'),
    networks:     tableModified('networks'),
    credentials:  tableModified('credentials'),
    findings:     tableModified('findings'),
    activity:     tableModified('activity'),
    meta:         db.prepare('SELECT modified FROM meta WHERE id=1').get()?.modified ?? 0,
    map_positions:db.prepare('SELECT modified FROM map_positions WHERE id=1').get()?.modified ?? 0,
  });
});

/**
 * GET /api/state
 * Full state read — used on initial load and full-sync fallback.
 */
app.get('/api/state', (req, res) => {
  const metaRow = db.prepare('SELECT data FROM meta WHERE id=1').get();
  const mapRow  = db.prepare('SELECT data FROM map_positions WHERE id=1').get();
  res.json({
    meta:         JSON.parse(metaRow?.data || '{}'),
    hosts:        allRecords('hosts'),
    networks:     allRecords('networks'),
    credentials:  allRecords('credentials'),
    findings:     allRecords('findings'),
    activity:     allRecords('activity'),
    mapPositions: JSON.parse(mapRow?.data || '{}'),
  });
});

/**
 * GET /api/table/:type
 * Fetch all records for a single table — used by poll when only one table changed.
 */
app.get('/api/table/:type', (req, res) => {
  const { type } = req.params;
  if (!RECORD_TABLES.includes(type)) return res.status(400).json({ error: 'Unknown table' });
  res.json(allRecords(type));
});

/**
 * PUT /api/records/:type/:id
 * Upsert a single record. Concurrent-safe — only touches one row.
 */
app.put('/api/records/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (!RECORD_TABLES.includes(type)) return res.status(400).json({ error: 'Unknown table' });
  const modified = Date.now();
  const data = JSON.stringify({ ...req.body, id });
  db.prepare(`INSERT INTO "${type}" (id, data, modified) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET data=excluded.data, modified=excluded.modified`)
    .run(id, data, modified);
  res.json({ ok: true, modified });
});

/**
 * DELETE /api/records/:type/:id
 * Delete a single record. Concurrent-safe — only touches one row.
 */
app.delete('/api/records/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (!RECORD_TABLES.includes(type)) return res.status(400).json({ error: 'Unknown table' });
  db.prepare(`DELETE FROM "${type}" WHERE id = ?`).run(id);
  res.json({ ok: true });
});

/**
 * GET /api/meta
 */
app.get('/api/meta', (req, res) => {
  const row = db.prepare('SELECT data FROM meta WHERE id=1').get();
  res.type('json').send(row?.data || '{}');
});

/**
 * GET /api/map-positions
 */
app.get('/api/map-positions', (req, res) => {
  const row = db.prepare('SELECT data FROM map_positions WHERE id=1').get();
  res.type('json').send(row?.data || '{}');
});

/**
 * PUT /api/meta
 * Save op metadata.
 */
app.put('/api/meta', (req, res) => {
  const modified = Date.now();
  db.prepare('UPDATE meta SET data = ?, modified = ? WHERE id = 1')
    .run(JSON.stringify(req.body), modified);
  res.json({ ok: true, modified });
});

/**
 * PUT /api/map-positions
 * Save map node positions.
 */
app.put('/api/map-positions', (req, res) => {
  const modified = Date.now();
  db.prepare('UPDATE map_positions SET data = ?, modified = ? WHERE id = 1')
    .run(JSON.stringify(req.body), modified);
  res.json({ ok: true, modified });
});

/**
 * POST /api/import
 * Bulk import — replaces all data. Wrapped in a transaction for atomicity.
 */
app.post('/api/import', (req, res) => {
  const { meta, hosts=[], networks=[], credentials=[], findings=[], activity=[], mapPositions={} } = req.body;
  const modified = Date.now();
  const importAll = db.transaction(() => {
    for (const table of RECORD_TABLES) db.prepare(`DELETE FROM "${table}"`).run();
    const ins = table => db.prepare(
      `INSERT INTO "${table}" (id, data, modified) VALUES (?, ?, ?)`
    );
    for (const r of hosts)       ins('hosts').run(r.id, JSON.stringify(r), modified);
    for (const r of networks)    ins('networks').run(r.id, JSON.stringify(r), modified);
    for (const r of credentials) ins('credentials').run(r.id, JSON.stringify(r), modified);
    for (const r of findings)    ins('findings').run(r.id, JSON.stringify(r), modified);
    for (const r of activity)    ins('activity').run(r.id, JSON.stringify(r), modified);
    if (meta) db.prepare('UPDATE meta SET data=?, modified=? WHERE id=1')
                .run(JSON.stringify(meta), modified);
    db.prepare('UPDATE map_positions SET data=?, modified=? WHERE id=1')
      .run(JSON.stringify(mapPositions), modified);
  });
  importAll();
  res.json({ ok: true, modified });
});

// ─── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Pentest Ops Dashboard  →  http://localhost:${PORT}\n`);
});
