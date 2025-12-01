// server.js
// Express server that generates one random keyboard character per second,
// saves to SQLite, broadcasts via SSE, serves static client, and archives old rows.
//
// This version explicitly avoids emitting newline/carriage-return/tab characters.
// Any control whitespace is replaced with a normal space before storing/broadcasting.

const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const DB_PATH = path.join(DATA_DIR, 'monkeys.db');

// Configuration (change in code to set global behavior)
const DISPLAY_LIMIT = 200;           // X: number of characters shown on page (global)
const GENERATION_INTERVAL_MS = 1000; // 1 second
const MAX_KEEP = 1_000_000;          // Keep newest up to MAX_KEEP rows in main DB; older rows will be archived.

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

// Open DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open DB:', err);
    process.exit(1);
  }
});

// Create table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      char TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
});

// SSE clients
let clients = [];

// Broadcast helper
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch (e) { /* ignore write errors */ }
  });
}

// Keyboard set (explicit printable characters; no CR/LF/TAB included)
// NOTE: this literal contains no newline characters.
const KEYBOARD = (
  "abcdefghijklmnopqrstuvwxyz" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "0123456789" +
  "`~!@#$%^&*()-_=+[{]}\\|;:'\",<.>/? "
).split('');

// Pick a random character from KEYBOARD
function randomChar() {
  return KEYBOARD[Math.floor(Math.random() * KEYBOARD.length)];
}

// Sanitize a character: replace CR/LF/TAB or other control whitespace with a normal space.
// Also ensure the stored value is exactly one character.
function sanitizeChar(ch) {
  if (!ch || typeof ch !== 'string') return ' ';
  // Replace carriage return, newline, tab with space
  const cleaned = ch.replace(/[\r\n\t]/g, ' ');
  // If it ends up empty, return space, otherwise take the first code unit
  return cleaned.length === 0 ? ' ' : cleaned[0];
}

// Insert helper (ensures sanitized char is stored)
function insertChar(char, ts, cb) {
  const safeChar = sanitizeChar(char);
  db.run('INSERT INTO output (char, ts) VALUES (?, ?)', [safeChar, ts], function (err) {
    if (err) {
      console.error('DB insert error:', err);
      return cb && cb(err);
    }
    cb && cb(null, { id: this.lastID, char: safeChar, ts });
  });
}

// Archiving lock
let archiving = false;

// Archive oldest rows until total count <= MAX_KEEP
function maybeArchiveIfNeeded() {
  if (archiving) return;
  archiving = true;

  db.get('SELECT COUNT(*) AS cnt, MIN(id) AS minId, MAX(id) AS maxId FROM output', (err, row) => {
    if (err) {
      console.error('Count error:', err);
      archiving = false;
      return;
    }
    const count = row ? row.cnt : 0;
    if (count <= MAX_KEEP) {
      archiving = false;
      return;
    }

    const numToArchive = count - MAX_KEEP;
    // Select the oldest numToArchive rows (ordered by id asc)
    db.all('SELECT id, char, ts FROM output ORDER BY id ASC LIMIT ?', [numToArchive], (err2, rows) => {
      if (err2) {
        console.error('Select rows to archive error:', err2);
        archiving = false;
        return;
      }
      if (!rows || rows.length === 0) {
        archiving = false;
        return;
      }

      const lastId = rows[rows.length - 1].id;
      // Prepare gzipped JSONL file
      const timestamp = Date.now();
      const filename = `archive-${lastId}-${timestamp}.json.gz`;
      const filepath = path.join(ARCHIVE_DIR, filename);

      const gzip = zlib.createGzip();
      const out = fs.createWriteStream(filepath);
      gzip.pipe(out);

      // Write JSON lines
      for (const r of rows) {
        gzip.write(JSON.stringify(r) + '\n');
      }
      gzip.end();

      out.on('finish', () => {
        // Delete archived rows from main table using id <= lastId
        db.run('DELETE FROM output WHERE id <= ?', [lastId], function (delErr) {
          if (delErr) {
            console.error('Failed to delete archived rows:', delErr);
            // We kept the archive file on disk on error
          } else {
            console.log(`Archived ${rows.length} rows to ${filename} and removed from main DB.`);
          }
          archiving = false;
        });
      });

      out.on('error', (e) => {
        console.error('Archive file write error:', e);
        archiving = false;
      });
    });
  });
}

// Background generator
setInterval(() => {
  const ch = randomChar();
  const ts = Date.now();
  insertChar(ch, ts, (err, row) => {
    if (!err && row) {
      broadcast(row);
      // After each insert, check archiving asynchronously but not blocking
      setImmediate(() => maybeArchiveIfNeeded());
    }
  });
}, GENERATION_INTERVAL_MS);

// Express setup
const expressApp = express();
expressApp.use(express.json());
expressApp.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint
expressApp.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // initial comment to establish connection
  res.write(': connected\n\n');

  clients.push(res);

  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

// API: /config returns global settings (display limit)
expressApp.get('/config', (req, res) => {
  res.json({
    displayLimit: DISPLAY_LIMIT,
    generationIntervalMs: GENERATION_INTERVAL_MS,
    maxKeep: MAX_KEEP
  });
});

// API: recent (server enforces DISPLAY_LIMIT)
expressApp.get('/recent', (req, res) => {
  const limit = DISPLAY_LIMIT;
  // select newest rows up to limit, then reverse to chronological order
  db.all('SELECT id, char, ts FROM output ORDER BY id DESC LIMIT ?', [limit], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.reverse());
  });
});

expressApp.get('/health', (req, res) => res.json({ ok: true }));

expressApp.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`DISPLAY_LIMIT=${DISPLAY_LIMIT}, GENERATION_INTERVAL_MS=${GENERATION_INTERVAL_MS}, MAX_KEEP=${MAX_KEEP}`);
});