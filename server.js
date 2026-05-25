const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./lib/db');
const { runPlacement, computeStatus } = require('./lib/placement');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'cheercamp-housing-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30d
  }
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- middleware ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}
function canAccessLocation(req, loc) {
  return req.session.role === 'admin' || loc.created_by === req.session.userId;
}
function getAccessibleLocation(req, id) {
  const loc = db.prepare('SELECT * FROM locations WHERE id=?').get(id);
  if (!loc || !canAccessLocation(req, loc)) return null;
  return loc;
}
function getAccessibleFile(req, id) {
  return db.prepare(`
    SELECT f.*
    FROM location_files f
    JOIN locations l ON l.id = f.location_id
    WHERE f.id=?
      AND (?='admin' OR l.created_by=?)
  `).get(id, req.session.role, req.session.userId);
}

// ---------- auth ----------
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be 8+ chars' });
  const emailLower = String(email).toLowerCase().trim();
  const exists = db.prepare('SELECT id, status FROM users WHERE email=?').get(emailLower);
  if (exists) return res.status(409).json({ error: 'email already registered', status: exists.status });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (name, email, password_hash, status, role, created_at)
    VALUES (?, ?, ?, 'pending', 'user', ?)
  `).run(String(name).trim(), emailLower, hash, Date.now());
  res.json({ ok: true, id: info.lastInsertRowid, status: 'pending' });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
  if (u.status !== 'approved') return res.status(403).json({ error: `account ${u.status}`, status: u.status });
  req.session.userId = u.id;
  req.session.role = u.role;
  req.session.name = u.name;
  res.json({ ok: true, user: { id: u.id, name: u.name, email: u.email, role: u.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  const u = db.prepare('SELECT id, name, email, role, status FROM users WHERE id=?').get(req.session.userId);
  if (!u) { req.session.destroy(()=>{}); return res.status(401).json({ error: 'unauthorized' }); }
  res.json({ user: u });
});

// ---------- admin: user management ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email, status, role, created_at, approved_at
    FROM users ORDER BY status='pending' DESC, created_at DESC
  `).all();
  res.json({ users });
});

app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare(`UPDATE users SET status='approved', approved_at=?, approved_by=? WHERE id=? AND status='pending'`)
    .run(Date.now(), req.session.userId, id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reject', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare(`UPDATE users SET status='rejected' WHERE id=? AND status='pending'`).run(id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
  res.json({ ok: true });
});

// ---------- locations ----------
app.get('/api/locations', requireAuth, (req, res) => {
  const sql = `
    SELECT l.*, u.name AS created_by_name,
      (SELECT COUNT(*) FROM location_files WHERE location_id=l.id AND kind='raw') AS has_raw,
      (SELECT COUNT(*) FROM location_files WHERE location_id=l.id AND kind='blank') AS has_blank,
      (SELECT COUNT(*) FROM location_files WHERE location_id=l.id AND kind='reference') AS has_reference,
      (SELECT COUNT(*) FROM location_files WHERE location_id=l.id AND kind='floorplan') AS floorplan_count,
      (SELECT MAX(run_at) FROM placements WHERE location_id=l.id) AS last_run
    FROM locations l
    LEFT JOIN users u ON u.id = l.created_by
    WHERE (?='admin' OR l.created_by=?)
    ORDER BY l.updated_at DESC
  `;
  const rows = db.prepare(sql).all(req.session.role, req.session.userId);
  res.json({ locations: rows });
});

app.post('/api/locations', requireAuth, (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const t = Date.now();
  const info = db.prepare(`
    INSERT INTO locations (name, description, status, created_by, created_at, updated_at)
    VALUES (?, ?, 'not_started', ?, ?, ?)
  `).run(String(name).trim(), String(description || '').trim(), req.session.userId, t, t);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.get('/api/locations/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const loc = getAccessibleLocation(req, id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const files = db.prepare(`
    SELECT id, kind, filename, mime_type, size_bytes, uploaded_at FROM location_files
    WHERE location_id=? ORDER BY kind, uploaded_at DESC
  `).all(id);
  const placements = db.prepare(`
    SELECT id, run_at, status, total_beds, placed, output_file_id
    FROM placements WHERE location_id=? ORDER BY run_at DESC LIMIT 10
  `).all(id);
  res.json({ location: loc, files, placements });
});

app.delete('/api/locations/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM locations WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// ---------- files ----------
app.post('/api/locations/:id/files', requireAuth, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id);
  const loc = getAccessibleLocation(req, id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const kind = req.body.kind;
  if (!['raw', 'blank', 'reference', 'floorplan'].includes(kind))
    return res.status(400).json({ error: 'invalid kind' });
  if (!req.file) return res.status(400).json({ error: 'no file' });

  // For non-floorplan kinds, replace any existing file (one of each per location)
  if (kind !== 'floorplan') {
    db.prepare('DELETE FROM location_files WHERE location_id=? AND kind=?').run(id, kind);
  }
  db.prepare(`
    INSERT INTO location_files (location_id, kind, filename, mime_type, size_bytes, blob, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, kind, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.session.userId, Date.now());
  db.prepare('UPDATE locations SET updated_at=? WHERE id=?').run(Date.now(), id);
  res.json({ ok: true });
});

app.get('/api/files/:id', requireAuth, (req, res) => {
  const f = getAccessibleFile(req, parseInt(req.params.id));
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.send(f.blob);
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const f = getAccessibleFile(req, parseInt(req.params.id));
  if (!f) return res.status(404).end();
  db.prepare('DELETE FROM location_files WHERE id=?').run(f.id);
  res.json({ ok: true });
});

// ---------- placement run ----------
app.post('/api/locations/:id/run', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const loc = getAccessibleLocation(req, id);
  if (!loc) return res.status(404).json({ error: 'not found' });

  const getFile = (kind) => db.prepare('SELECT * FROM location_files WHERE location_id=? AND kind=? ORDER BY uploaded_at DESC LIMIT 1').get(id, kind);
  const raw = getFile('raw');
  const blank = getFile('blank');
  if (!raw || !blank) return res.status(400).json({ error: 'raw and blank template files required' });
  const ref = getFile('reference');

  try {
    const result = await runPlacement(raw.blob, blank.blob, ref ? ref.blob : null);
    const status = computeStatus(result);

    // Store output file
    const outFilename = `${loc.name.replace(/[^A-Za-z0-9_-]/g, '_')}_Placeholder.xlsx`;
    const outInfo = db.prepare(`
      INSERT INTO location_files (location_id, kind, filename, mime_type, size_bytes, blob, uploaded_by, uploaded_at)
      VALUES (?, 'output', ?, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ?, ?, ?, ?)
    `).run(id, outFilename, result.outputBuffer.length, result.outputBuffer, req.session.userId, Date.now());

    db.prepare(`
      INSERT INTO placements (location_id, run_at, run_by, status, total_beds, placed, warnings_json, compliance_json, assignments_json, output_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, Date.now(), req.session.userId,
      status,
      result.beds, result.placed,
      JSON.stringify(result.warnings || []),
      JSON.stringify(result.compliance || {}),
      JSON.stringify(result.assignments || []),
      outInfo.lastInsertRowid
    );

    db.prepare('UPDATE locations SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), id);

    res.json({
      ok: true,
      status,
      beds: result.beds,
      placed: result.placed,
      compliance: result.compliance,
      warnings: result.warnings,
      halls: result.halls,
      output_file_id: outInfo.lastInsertRowid
    });
  } catch (e) {
    console.error('placement failed:', e);
    db.prepare('UPDATE locations SET status=?, updated_at=? WHERE id=?').run('errors', Date.now(), id);
    res.status(500).json({ error: 'placement failed', message: e.message });
  }
});

app.get('/api/locations/:id/placement', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const loc = getAccessibleLocation(req, id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const p = db.prepare(`SELECT * FROM placements WHERE location_id=? ORDER BY run_at DESC LIMIT 1`).get(id);
  if (!p) return res.json({ placement: null });
  res.json({
    placement: {
      ...p,
      warnings: JSON.parse(p.warnings_json || '[]'),
      compliance: JSON.parse(p.compliance_json || '{}'),
      assignments: JSON.parse(p.assignments_json || '[]')
    }
  });
});

// ---------- static + routing ----------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (!req.session.userId) return res.sendFile(path.join(__dirname, 'public', 'gate.html'));
  if (req.session.role === 'admin') return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  return res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/admin', (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/app', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/location/:id', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'location.html'));
});

app.listen(PORT, () => {
  console.log(`Cheer camp housing server listening on port ${PORT}`);
});
