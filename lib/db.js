const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
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
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by INTEGER
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'not_started', -- not_started | in_process | completed | errors
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notes TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS location_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                          -- raw | blank | reference | floorplan | output
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  blob BLOB NOT NULL,
  uploaded_by INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  run_by INTEGER NOT NULL,
  status TEXT NOT NULL,                        -- success | partial | failed
  total_beds INTEGER,
  placed INTEGER,
  warnings_json TEXT,
  compliance_json TEXT,
  assignments_json TEXT,
  output_file_id INTEGER,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (run_by) REFERENCES users(id),
  FOREIGN KEY (output_file_id) REFERENCES location_files(id)
);

CREATE INDEX IF NOT EXISTS idx_files_loc_kind ON location_files(location_id, kind);
CREATE INDEX IF NOT EXISTS idx_placements_loc ON placements(location_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
`);

// --- Bootstrap Parker Jackson as the master admin if no admin exists ---
const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
if (adminCount === 0) {
  const defaultEmail = (process.env.PARKER_EMAIL || 'pjackson@varsity.com').toLowerCase();
  const defaultPw = process.env.PARKER_PW || 'Varsity2026';
  const hash = bcrypt.hashSync(defaultPw, 10);
  db.prepare(`
    INSERT INTO users (name, email, password_hash, status, role, created_at, approved_at)
    VALUES (?, ?, ?, 'approved', 'admin', ?, ?)
  `).run('Parker Jackson', defaultEmail, hash, Date.now(), Date.now());
  console.log(`[bootstrap] Parker Jackson seeded. Email: ${defaultEmail} | Password: ${defaultPw}`);
}

module.exports = db;
