// db.js — SQLite database setup and schema (uses Node's built-in SQLite, no native deps)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'examprepper.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  num_questions INTEGER NOT NULL DEFAULT 20,
  difficulty TEXT NOT NULL DEFAULT 'mixed', -- easy | medium | hard | mixed
  timer_minutes INTEGER NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'new', -- new | generating | ready | error
  status_message TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,          -- JSON array of 4 answer options
  correct_index INTEGER NOT NULL,      -- 0-3
  difficulty TEXT NOT NULL DEFAULT 'medium',
  explanation TEXT NOT NULL DEFAULT '',
  learn_more_query TEXT NOT NULL DEFAULT '', -- fallback web-search query
  source_url TEXT NOT NULL DEFAULT '',       -- link to a source webpage to explore further (opens in new tab)
  source_title TEXT NOT NULL DEFAULT '',     -- human-readable title of that source page
  deep_dive TEXT DEFAULT NULL                -- (legacy, unused) previously cached AI article
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,                  -- exam | review
  score INTEGER,
  total INTEGER,
  duration_seconds INTEGER,
  answers_json TEXT,                   -- JSON: [{questionId, chosenIndex}]
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Lightweight migration: add newer columns to databases created before they existed.
const questionCols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
const addColumns = [
  ['source_url', "TEXT NOT NULL DEFAULT ''"],
  ['source_title', "TEXT NOT NULL DEFAULT ''"]
];
for (const [name, ddl] of addColumns) {
  if (!questionCols.includes(name)) db.exec('ALTER TABLE questions ADD COLUMN ' + name + ' ' + ddl);
}

// Helpers for app settings (e.g. the Anthropic API key)
function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = { db, getSetting, setSetting };
