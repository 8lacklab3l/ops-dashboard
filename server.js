'use strict';

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

const app     = express();
const PORT    = process.env.PORT    || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'pentest.db');

// ─── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    data     TEXT    NOT NULL,
    modified INTEGER NOT NULL
  )
`);

const EMPTY_STATE = JSON.stringify({
  meta: { opName:'Unnamed Op', scope:'', notes:'', targetPrefix:'',
          created:Date.now(), modified:Date.now() },
  hosts:[], networks:[], credentials:[], findings:[], activity:[], mapPositions:{},
});

db.prepare('INSERT OR IGNORE INTO state (id, data, modified) VALUES (1, ?, ?)')
  .run(EMPTY_STATE, Date.now());

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ─── API ───────────────────────────────────────────────────────────────────────

// Lightweight poll — just returns the server's last-modified timestamp
app.get('/api/ping', (req, res) => {
  const row = db.prepare('SELECT modified FROM state WHERE id = 1').get();
  res.json({ ok: true, modified: row?.modified ?? 0 });
});

// Full state read
app.get('/api/state', (req, res) => {
  const row = db.prepare('SELECT data FROM state WHERE id = 1').get();
  res.type('json').send(row.data);
});

// Full state write (last-writer-wins)
app.post('/api/state', (req, res) => {
  const modified = Date.now();
  db.prepare('UPDATE state SET data = ?, modified = ? WHERE id = 1')
    .run(JSON.stringify(req.body), modified);
  res.json({ ok: true, modified });
});

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Pentest Ops Dashboard  →  http://localhost:${PORT}\n`);
});
