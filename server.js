const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new Database(path.join(__dirname, 'jukebox.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    song TEXT NOT NULL,
    artist TEXT,
    requester_id TEXT,
    status TEXT DEFAULT 'queued',
    votes INTEGER DEFAULT 1,
    position INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    played_at DATETIME,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS votes (
    request_id INTEGER,
    voter_id TEXT,
    PRIMARY KEY (request_id, voter_id),
    FOREIGN KEY (request_id) REFERENCES requests(id)
  );
`);

// In-memory PIN storage: sessionId -> pin
const sessionPins = new Map();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cookie middleware - set jukebox_id if not present
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || '');
  if (!cookies.jukebox_id) {
    const id = crypto.randomUUID();
    res.setHeader('Set-Cookie', `jukebox_id=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    req.jukeboxId = id;
  } else {
    req.jukeboxId = cookies.jukebox_id;
  }
  next();
});

function parseCookies(cookieStr) {
  const cookies = {};
  cookieStr.split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) cookies[k] = v;
  });
  return cookies;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function requirePin(req, res, sessionId) {
  const pin = req.headers['x-pin'];
  if (!pin || sessionPins.get(sessionId) !== pin) {
    res.status(401).json({ error: 'Invalid PIN' });
    return false;
  }
  return true;
}

// Routes
app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'session.html'));
});

// API: Sessions
app.post('/api/sessions', (req, res) => {
  const { name, pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const id = generateCode();
  db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(id, name || null);
  sessionPins.set(id, pin);
  res.json({ id, name });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const count = db.prepare('SELECT COUNT(*) as c FROM requests WHERE session_id = ?').get(req.params.id);
  res.json({ ...session, requestCount: count.c });
});

app.patch('/api/sessions/:id', (req, res) => {
  if (!requirePin(req, res, req.params.id)) return;
  const { active } = req.body;
  if (active !== undefined) {
    db.prepare('UPDATE sessions SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  res.json(session);
});

// API: Requests
app.get('/api/sessions/:id/requests', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM votes v WHERE v.request_id = r.id AND v.voter_id = ?) as my_vote
    FROM requests r WHERE r.session_id = ?
    ORDER BY
      CASE r.status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
      CASE WHEN r.status = 'queued' THEN -r.votes END,
      CASE WHEN r.status = 'queued' THEN r.created_at END,
      r.played_at DESC
  `).all(req.jukeboxId, req.params.id);
  res.json(rows);
});

app.post('/api/sessions/:id/requests', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.active) return res.status(403).json({ error: 'Session is closed' });

  const { song, artist } = req.body;
  if (!song || !song.trim()) return res.status(400).json({ error: 'Song name required' });

  // Rate limit: 10 requests per user per session
  const userCount = db.prepare('SELECT COUNT(*) as c FROM requests WHERE session_id = ? AND requester_id = ?').get(req.params.id, req.jukeboxId);
  if (userCount.c >= 10) return res.status(429).json({ error: 'Request limit reached (10 per session)' });

  // Duplicate detection
  const existing = db.prepare(`
    SELECT * FROM requests WHERE session_id = ? AND status = 'queued'
    AND LOWER(TRIM(song)) = LOWER(TRIM(?)) AND LOWER(TRIM(COALESCE(artist,''))) = LOWER(TRIM(COALESCE(?,'')))
  `).get(req.params.id, song.trim(), artist?.trim() || '');

  if (existing) {
    // Auto-upvote
    const alreadyVoted = db.prepare('SELECT 1 FROM votes WHERE request_id = ? AND voter_id = ?').get(existing.id, req.jukeboxId);
    if (!alreadyVoted) {
      db.prepare('INSERT INTO votes (request_id, voter_id) VALUES (?, ?)').run(existing.id, req.jukeboxId);
      db.prepare('UPDATE requests SET votes = votes + 1 WHERE id = ?').run(existing.id);
    }
    const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(existing.id);
    return res.json({ ...updated, duplicate: true });
  }

  const result = db.prepare('INSERT INTO requests (session_id, song, artist, requester_id) VALUES (?, ?, ?, ?)').run(req.params.id, song.trim(), artist?.trim() || null, req.jukeboxId);
  // Record initial vote
  db.prepare('INSERT INTO votes (request_id, voter_id) VALUES (?, ?)').run(result.lastInsertRowid, req.jukeboxId);
  const created = db.prepare('SELECT * FROM requests WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(created);
});

app.post('/api/requests/:id/vote', (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const existing = db.prepare('SELECT 1 FROM votes WHERE request_id = ? AND voter_id = ?').get(req.params.id, req.jukeboxId);
  if (existing) {
    // Toggle off
    db.prepare('DELETE FROM votes WHERE request_id = ? AND voter_id = ?').run(req.params.id, req.jukeboxId);
    db.prepare('UPDATE requests SET votes = votes - 1 WHERE id = ?').run(req.params.id);
  } else {
    db.prepare('INSERT INTO votes (request_id, voter_id) VALUES (?, ?)').run(req.params.id, req.jukeboxId);
    db.prepare('UPDATE requests SET votes = votes + 1 WHERE id = ?').run(req.params.id);
  }
  const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.patch('/api/requests/:id', (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (!requirePin(req, res, request.session_id)) return;

  const { status } = req.body;
  if (status === 'playing') {
    // Move current playing to played
    db.prepare("UPDATE requests SET status = 'played', played_at = CURRENT_TIMESTAMP WHERE session_id = ? AND status = 'playing'").run(request.session_id);
  }
  const playedAt = (status === 'played' || status === 'playing') ? new Date().toISOString() : null;
  if (status === 'played' || status === 'skipped') {
    db.prepare('UPDATE requests SET status = ?, played_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  } else {
    db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, req.params.id);
  }
  const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/requests/:id', (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (!requirePin(req, res, request.session_id)) return;
  db.prepare('DELETE FROM votes WHERE request_id = ?').run(req.params.id);
  db.prepare('DELETE FROM requests WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Jukebox running at http://127.0.0.1:${PORT}`);
});
