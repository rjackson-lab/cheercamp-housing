const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'housing.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by INTEGER
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notes TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS location_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  session_id INTEGER,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  blob BLOB NOT NULL,
  uploaded_by INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  location_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  notes TEXT,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  session_id INTEGER,
  run_at INTEGER NOT NULL,
  run_by INTEGER NOT NULL,
  status TEXT NOT NULL,
  total_beds INTEGER,
  placed INTEGER,
  warnings_json TEXT,
  compliance_json TEXT,
  assignments_json TEXT,
  output_file_id INTEGER,
  is_approved INTEGER NOT NULL DEFAULT 0,
  approved_at INTEGER,
  approved_by INTEGER,
  finalized_at INTEGER,
  finalized_by INTEGER,
  final_file_id INTEGER,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (run_by) REFERENCES users(id),
  FOREIGN KEY (output_file_id) REFERENCES location_files(id)
);

CREATE TABLE IF NOT EXISTS location_members (
  location_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (location_id, user_id),
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER,
  session_id INTEGER,
  user_id INTEGER,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_loc_kind ON location_files(location_id, kind);
CREATE INDEX IF NOT EXISTS idx_placements_loc ON placements(location_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(created_by, updated_at DESC);
`);

// Migrate existing placements table (add columns if missing)
const placementCols = db.prepare("PRAGMA table_info(placements)").all().map(c => c.name);
for (const [col, def] of [
  ['is_approved', 'INTEGER NOT NULL DEFAULT 0'],
  ['approved_at', 'INTEGER'],
  ['approved_by', 'INTEGER'],
  ['finalized_at', 'INTEGER'],
  ['finalized_by', 'INTEGER'],
  ['final_file_id', 'INTEGER'],
  ['session_id', 'INTEGER']
]) {
  if (!placementCols.includes(col)) {
    try { db.prepare(`ALTER TABLE placements ADD COLUMN ${col} ${def}`).run(); } catch(e) {}
  }
}

// Migrate location_files (add session_id)
const fileCols = db.prepare("PRAGMA table_info(location_files)").all().map(c => c.name);
if (!fileCols.includes('session_id')) {
  try { db.prepare('ALTER TABLE location_files ADD COLUMN session_id INTEGER').run(); } catch(e) {}
}

// Migrate chat_messages (add session_id)
const chatCols = db.prepare("PRAGMA table_info(chat_messages)").all().map(c => c.name);
if (!chatCols.includes('session_id')) {
  try { db.prepare('ALTER TABLE chat_messages ADD COLUMN session_id INTEGER').run(); } catch(e) {}
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_files_session ON location_files(session_id);
CREATE INDEX IF NOT EXISTS idx_placements_session ON placements(session_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, created_at);
`);

// Bootstrap Parker Jackson
const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
if (adminCount === 0) {
  const defaultEmail = (process.env.PARKER_EMAIL || 'pjackson@varsity.com').toLowerCase();
  let defaultPw = process.env.PARKER_PW;
  if (!defaultPw) {
    if (process.env.NODE_ENV === 'production') {
      defaultPw = crypto.randomBytes(18).toString('base64url');
      console.log(`[bootstrap] Generated first-login password: ${defaultPw}`);
      console.log('[bootstrap] Set PARKER_PW in Render environment variables before redeploying or store this password now.');
    } else {
      defaultPw = 'Varsity2026';
    }
  }
  const hash = bcrypt.hashSync(defaultPw, 10);
  db.prepare(`
    INSERT INTO users (name, email, password_hash, status, role, created_at, approved_at)
    VALUES (?, ?, ?, 'approved', 'admin', ?, ?)
  `).run('Parker Jackson', defaultEmail, hash, Date.now(), Date.now());
  console.log(`[bootstrap] Parker Jackson seeded. Email: ${defaultEmail}`);
}

module.exports = db;
