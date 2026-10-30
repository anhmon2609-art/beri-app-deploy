'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataDir, 'beri.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  parent_balance INTEGER NOT NULL DEFAULT 1000000000,
  child_balance INTEGER NOT NULL DEFAULT 0,
  daily_max_minutes INTEGER NOT NULL DEFAULT 120,
  streak_days INTEGER NOT NULL DEFAULT 0,
  last_task_date TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('parent','child')),
  display_name TEXT NOT NULL,
  device_token TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rewards (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS penalties (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_custom INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pending_tasks (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  reward_id TEXT,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  child_member_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  actor_role TEXT,
  balance_after_parent INTEGER,
  balance_after_child INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('phone','tv')),
  minutes INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  warned_5 INTEGER NOT NULL DEFAULT 0,
  ended INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_history_family ON history(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_family ON pending_tasks(family_id, status);
CREATE INDEX IF NOT EXISTS idx_members_family ON members(family_id);
`);

const DEFAULT_REWARDS = [
  ['Quét nhà', 5000],
  ['Đổ rác', 5000],
  ['Lau nhà', 10000],
  ['Cất đồ chơi', 5000],
  ['Lau bàn', 5000],
  ['Phơi quần áo', 5000],
  ['Thu quần áo', 5000],
  ['Sắp xếp giày dép', 5000],
  ['Dọn giường', 5000],
  ['Tự giác hoàn thành bài tập', 15000],
  ['Dọn góc học tập', 10000],
  ['Đi bộ thể dục mỗi ngày', 15000],
  ['Gấp quần áo', 5000],
  ['Điểm thi trên 9', 10000],
];

const DEFAULT_PENALTIES = [
  ['Nổi nóng', -10000],
  ['Trì hoãn', -10000],
  ['Nói tục', -10000],
  ['Cãi lời', -10000],
  ['To tiếng với người lớn', -20000],
  ['Thái độ lồi lõm', -20000],
];

function seedFromDumpIfEmpty() {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM families').get();
    if (row && row.c > 0) return;
    const seedPath = process.env.SEED_SQL
      || path.join(__dirname, '..', 'data', 'export', 'beri-dump.sql');
    if (!fs.existsSync(seedPath)) return;
    const sql = fs.readFileSync(seedPath, 'utf8');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(sql);
    db.exec('PRAGMA foreign_keys = ON;');
    console.log('Seeded database from', seedPath);
  } catch (err) {
    console.warn('Seed skipped:', err.message);
  }
}
seedFromDumpIfEmpty();

module.exports = { db, dbPath, DEFAULT_REWARDS, DEFAULT_PENALTIES };
