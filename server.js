const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const db = require('./lib/db');
const { runPlacement, computeStatus, finalizeWithNames } = require('./lib/placement');
const { sendMail } = require('./lib/mail');
const { askPlacementAssistant } = require('./lib/ai');

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
  if (req.session.role === 'admin' || loc.created_by === req.session.userId) return true;
  const member = db.prepare('SELECT 1 FROM location_members WHERE location_id=? AND user_id=?')
    .get(loc.id, req.session.userId);
  return !!member;
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
      AND (?='admin' OR l.created_by=? OR EXISTS (
        SELECT 1 FROM location_members lm WHERE lm.location_id=l.id AND lm.user_id=?
      ))
  `).get(id, req.session.role, req.session.userId, req.session.userId);
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

app.post('/api/password/reset/request', (req, res) => {
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  if (!email) return res.json({ ok: true });
  const user = db.prepare("SELECT id, email, name FROM users WHERE email=? AND status='approved'").get(email);
  if (!user) return res.json({ ok: true });
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + 60 * 60 * 1000;
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(token, user.id, expiresAt, Date.now());
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${base.replace(/\/$/, '')}/reset?token=${encodeURIComponent(token)}`;
  sendMail({
    to: user.email,
    subject: 'Reset your Cheer Camp Housing password',
    text: `Use this link within 1 hour to reset your password: ${link}`,
    html: `<p>Use this link within 1 hour to reset your password:</p><p><a href="${link}">${link}</a></p>`
  }).catch(err => console.error('reset email failed:', err));
  res.json({ ok: true });
});

app.post('/api/password/reset/confirm', (req, res) => {
  const token = String((req.body || {}).token || '');
  const password = String((req.body || {}).password || '');
  if (!token || password.length < 8) return res.status(400).json({ error: 'valid token and 8+ character password required' });
  const row = db.prepare('SELECT * FROM password_resets WHERE token=? AND used=0').get(token);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'reset link is invalid or expired' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), row.user_id);
  db.prepare('UPDATE password_resets SET used=1 WHERE token=?').run(token);
  res.json({ ok: true });
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
    WHERE (?='admin' OR l.created_by=? OR EXISTS (
      SELECT 1 FROM location_members lm WHERE lm.location_id=l.id AND lm.user_id=?
    ))
    ORDER BY l.updated_at DESC
  `;
  const rows = db.prepare(sql).all(req.session.role, req.session.userId, req.session.userId);
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
    SELECT id, run_at, status, total_beds, placed, output_file_id, is_approved, approved_at, finalized_at, final_file_id
    FROM placements WHERE location_id=? ORDER BY run_at DESC LIMIT 10
  `).all(id);
  const members = db.prepare(`
    SELECT u.id, u.name, u.email, lm.added_at
    FROM location_members lm
    JOIN users u ON u.id=lm.user_id
    WHERE lm.location_id=?
    ORDER BY u.name
  `).all(id);
  res.json({ location: loc, files, placements, members });
});

app.post('/api/locations/:id/members', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const loc = getAccessibleLocation(req, id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  if (req.session.role !== 'admin' && loc.created_by !== req.session.userId) return res.status(403).json({ error: 'owner or admin only' });
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  const user = db.prepare("SELECT id, status FROM users WHERE email=?").get(email);
  if (!user || user.status !== 'approved') return res.status(404).json({ error: 'approved user not found' });
  db.prepare('INSERT OR IGNORE INTO location_members (location_id, user_id, added_at) VALUES (?, ?, ?)')
    .run(id, user.id, Date.now());
  res.json({ ok: true });
});

app.delete('/api/locations/:id/members/:userId', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const loc = getAccessibleLocation(req, id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  if (req.session.role !== 'admin' && loc.created_by !== req.session.userId) return res.status(403).json({ error: 'owner or admin only' });
  db.prepare('DELETE FROM location_members WHERE location_id=? AND user_id=?').run(id, parseInt(req.params.userId));
  res.json({ ok: true });
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

function assignmentCategory(label) {
  const cats = ['Athlete', 'Coach', 'Chaperone', 'Staff', 'Other'];
  return cats.find(cat => String(label || '').endsWith(` ${cat}`)) || 'Other';
}

function enrichAssignments(assignments, locationId) {
  const latestBlank = db.prepare(`
    SELECT blob FROM location_files
    WHERE location_id=? AND kind='blank'
    ORDER BY uploaded_at DESC LIMIT 1
  `).get(locationId);
  let rooms = {};
  if (latestBlank) {
    try {
      const XLSX = require('xlsx');
      const coreSrc = fs.readFileSync(path.join(__dirname, 'lib', '_placement_core.js'), 'utf8');
      const core = (new Function('XLSX', 'JSZip', coreSrc + '\nreturn { parseTemplate };'))(XLSX, require('jszip'));
      const wb = XLSX.read(latestBlank.blob, { type: 'buffer', cellStyles: true });
      for (const hall of core.parseTemplate(wb, wb)) {
        for (const room of hall.rooms) rooms[`${room.sheet}|${room.row}`] = room;
      }
    } catch (e) {
      console.warn('assignment enrichment skipped:', e.message);
    }
  }
  return (assignments || []).map((a, i) => {
    const room = rooms[`${a.sheet}|${a.row}`] || {};
    return {
      ...a,
      _idx: i,
      team: a.team || a.label || '',
      category: a.category || assignmentCategory(a.label),
      room_id: a.room_id || room.room_id || '',
      floor: a.floor || room.floor || '',
      suite_id: a.suite_id || room.suite_id || ''
    };
  });
}

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
      assignments: enrichAssignments(JSON.parse(p.assignments_json || '[]'), id)
    }
  });
});

app.post('/api/placements/:id/assignments/:idx', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM placements WHERE id=?').get(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  const loc = getAccessibleLocation(req, p.location_id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  if (p.is_approved) return res.status(400).json({ error: 'approved placements are locked' });
  const idx = parseInt(req.params.idx);
  const assignments = JSON.parse(p.assignments_json || '[]');
  if (!assignments[idx]) return res.status(404).json({ error: 'assignment not found' });
  const field = req.body.field;
  const value = String(req.body.value || '');
  if (field === 'gender' && ['Female', 'Male'].includes(value)) assignments[idx].gender = value;
  if (field === 'category' && ['Athlete', 'Coach', 'Chaperone', 'Staff', 'Other'].includes(value)) {
    assignments[idx].category = value;
    const base = String(assignments[idx].label || '').replace(/ (Athlete|Coach|Chaperone|Staff|Other)$/, '');
    assignments[idx].label = `${base} ${value}`;
  }
  db.prepare('UPDATE placements SET assignments_json=? WHERE id=?').run(JSON.stringify(assignments), p.id);
  res.json({ ok: true });
});

app.post('/api/placements/:id/approve', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM placements WHERE id=?').get(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  const loc = getAccessibleLocation(req, p.location_id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  db.prepare('UPDATE placements SET is_approved=1, approved_at=?, approved_by=? WHERE id=?')
    .run(Date.now(), req.session.userId, p.id);
  res.json({ ok: true });
});

app.post('/api/placements/:id/unapprove', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM placements WHERE id=?').get(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  const loc = getAccessibleLocation(req, p.location_id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  db.prepare('UPDATE placements SET is_approved=0, approved_at=NULL, approved_by=NULL WHERE id=?').run(p.id);
  res.json({ ok: true });
});

app.post('/api/placements/:id/finalize', requireAuth, async (req, res) => {
  const p = db.prepare('SELECT * FROM placements WHERE id=?').get(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  const loc = getAccessibleLocation(req, p.location_id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  if (!p.is_approved) return res.status(400).json({ error: 'approve placeholder before finalizing' });
  const raw = db.prepare("SELECT * FROM location_files WHERE location_id=? AND kind='raw' ORDER BY uploaded_at DESC LIMIT 1").get(p.location_id);
  const placeholder = db.prepare('SELECT * FROM location_files WHERE id=?').get(p.output_file_id);
  if (!raw || !placeholder) return res.status(400).json({ error: 'raw roster and placeholder output required' });
  try {
    const assignments = JSON.parse(p.assignments_json || '[]');
    const finalBuffer = await finalizeWithNames(raw.blob, placeholder.blob, assignments);
    const filename = `${loc.name.replace(/[^A-Za-z0-9_-]/g, '_')}_Final.xlsx`;
    const out = db.prepare(`
      INSERT INTO location_files (location_id, kind, filename, mime_type, size_bytes, blob, uploaded_by, uploaded_at)
      VALUES (?, 'final', ?, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ?, ?, ?, ?)
    `).run(p.location_id, filename, finalBuffer.length, finalBuffer, req.session.userId, Date.now());
    db.prepare('UPDATE placements SET finalized_at=?, finalized_by=?, final_file_id=? WHERE id=?')
      .run(Date.now(), req.session.userId, out.lastInsertRowid, p.id);
    db.prepare("UPDATE locations SET status='completed', updated_at=? WHERE id=?").run(Date.now(), p.location_id);
    res.json({ ok: true, final_file_id: out.lastInsertRowid });
  } catch (e) {
    console.error('finalize failed:', e);
    res.status(500).json({ error: 'finalize failed', message: e.message });
  }
});

app.post('/api/locations/:id/chat', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const loc = getAccessibleLocation(req, id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const message = String((req.body || {}).message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  db.prepare('INSERT INTO chat_messages (location_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.session.userId, 'user', message, Date.now());
  const p = db.prepare('SELECT * FROM placements WHERE location_id=? ORDER BY run_at DESC LIMIT 1').get(id);
  const placement = p ? { ...p, warnings: JSON.parse(p.warnings_json || '[]'), compliance: JSON.parse(p.compliance_json || '{}') } : null;
  const result = await askPlacementAssistant({ message, location: loc, placement });
  db.prepare('INSERT INTO chat_messages (location_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, null, 'assistant', result.reply, Date.now());
  res.json(result);
});

app.post('/api/placements/:id/apply-changes', requireAuth, (req, res) => {
  res.status(501).json({ error: 'AI change application is not automated yet. Apply edits in the review table.' });
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

app.get('/reset', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset.html'));
});

app.listen(PORT, () => {
  console.log(`Cheer camp housing server listening on port ${PORT}`);
});
