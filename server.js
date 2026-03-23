'use strict';

const { DatabaseSync } = require('node:sqlite');
const express  = require('express');
const path     = require('path');

const app     = express();
const PORT    = process.env.PORT    || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'pentest.db');

// ─── DATABASE ──────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);

// WAL mode for concurrent readers + one writer
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
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
  CREATE TABLE IF NOT EXISTS meta (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    data     TEXT    NOT NULL,
    modified INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_positions (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    data     TEXT    NOT NULL,
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

// Vendored frontend libraries — served from node_modules for offline/air-gapped use
app.use('/vendor/leaflet',           express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use('/vendor/chartjs',           express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
app.use('/vendor/chartjs-datefns',   express.static(path.join(__dirname, 'node_modules/chartjs-adapter-date-fns/dist')));

app.use(express.static(__dirname));

// ─── ROUTES ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pentest-dashboard.html'));
});

// ─── API ────────────────────────────────────────────────────────────────────────

app.get('/api/ping', (req, res) => {
  res.json({
    hosts:         tableModified('hosts'),
    networks:      tableModified('networks'),
    credentials:   tableModified('credentials'),
    findings:      tableModified('findings'),
    activity:      tableModified('activity'),
    meta:          db.prepare('SELECT modified FROM meta WHERE id=1').get()?.modified ?? 0,
    map_positions: db.prepare('SELECT modified FROM map_positions WHERE id=1').get()?.modified ?? 0,
  });
});

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

app.get('/api/table/:type', (req, res) => {
  const { type } = req.params;
  if (!RECORD_TABLES.includes(type)) return res.status(400).json({ error: 'Unknown table' });
  res.json(allRecords(type));
});

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

app.delete('/api/records/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (!RECORD_TABLES.includes(type)) return res.status(400).json({ error: 'Unknown table' });
  db.prepare(`DELETE FROM "${type}" WHERE id = ?`).run(id);
  res.json({ ok: true });
});

app.get('/api/meta', (req, res) => {
  const row = db.prepare('SELECT data FROM meta WHERE id=1').get();
  res.type('json').send(row?.data || '{}');
});

app.get('/api/map-positions', (req, res) => {
  const row = db.prepare('SELECT data FROM map_positions WHERE id=1').get();
  res.type('json').send(row?.data || '{}');
});

app.put('/api/meta', (req, res) => {
  const modified = Date.now();
  db.prepare('UPDATE meta SET data = ?, modified = ? WHERE id = 1')
    .run(JSON.stringify(req.body), modified);
  res.json({ ok: true, modified });
});

app.put('/api/map-positions', (req, res) => {
  const modified = Date.now();
  db.prepare('UPDATE map_positions SET data = ?, modified = ? WHERE id = 1')
    .run(JSON.stringify(req.body), modified);
  res.json({ ok: true, modified });
});

// ─── DB CONSOLE ─────────────────────────────────────────────────────────────
const SAFE_VERBS = new Set(['SELECT','WITH','EXPLAIN','PRAGMA','VALUES']);

// node:sqlite can return BigInt for large integers; JSON.stringify throws on them
function safeJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? Number(v) : v);
    res.status(status).type('json').send(body);
  } catch(e) {
    res.status(500).type('json').send(JSON.stringify({ error: 'Serialization error: ' + e.message }));
  }
}

app.post('/api/db/query', (req, res) => {
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'Missing sql' });
  const verb = sql.trim().replace(/\/\*[\s\S]*?\*\//g, '').trim().split(/\s+/)[0].toUpperCase();
  try {
    const stmt = db.prepare(sql.trim());
    if (SAFE_VERBS.has(verb)) {
      const rows = stmt.all();
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      safeJson(res, 200, { type: 'select', columns, rows, rowCount: rows.length });
    } else {
      const info = stmt.run();
      safeJson(res, 200, { type: 'exec', changes: info.changes, lastInsertRowid: String(info.lastInsertRowid) });
    }
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/import', (req, res) => {
  const { meta, hosts=[], networks=[], credentials=[], findings=[], activity=[], mapPositions={} } = req.body;
  const modified = Date.now();
  try {
    db.exec('BEGIN');
    for (const table of RECORD_TABLES) db.prepare(`DELETE FROM "${table}"`).run();
    const ins = table => db.prepare(`INSERT INTO "${table}" (id, data, modified) VALUES (?, ?, ?)`);
    for (const r of hosts)       ins('hosts').run(r.id, JSON.stringify(r), modified);
    for (const r of networks)    ins('networks').run(r.id, JSON.stringify(r), modified);
    for (const r of credentials) ins('credentials').run(r.id, JSON.stringify(r), modified);
    for (const r of findings)    ins('findings').run(r.id, JSON.stringify(r), modified);
    for (const r of activity)    ins('activity').run(r.id, JSON.stringify(r), modified);
    if (meta) db.prepare('UPDATE meta SET data=?, modified=? WHERE id=1')
                .run(JSON.stringify(meta), modified);
    db.prepare('UPDATE map_positions SET data=?, modified=? WHERE id=1')
      .run(JSON.stringify(mapPositions), modified);
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, modified });
});

// ─── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Pentest Ops Dashboard  →  http://localhost:${PORT}\n`);
});
