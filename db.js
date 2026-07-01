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
  material TEXT NOT NULL DEFAULT '',          -- optional pasted study material to ground generation
  question_types TEXT NOT NULL DEFAULT 'single', -- single | mixed (adds multi-select, true/false, fill-in-the-blank)
  is_shared INTEGER NOT NULL DEFAULT 0,       -- shared topics are visible to all users (read/practice only)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,          -- JSON array of answer options ([] for fillblank)
  correct_index INTEGER NOT NULL,      -- kept for single/truefalse (first correct index; -1 for fillblank)
  correct_json TEXT NOT NULL DEFAULT '', -- JSON array: option indices (single/multi/truefalse) or acceptable strings (fillblank)
  qtype TEXT NOT NULL DEFAULT 'single',  -- single | multi | truefalse | fillblank
  difficulty TEXT NOT NULL DEFAULT 'medium',
  explanation TEXT NOT NULL DEFAULT '',
  learn_more_query TEXT NOT NULL DEFAULT '', -- fallback web-search query
  source_url TEXT NOT NULL DEFAULT '',       -- link to a source webpage to explore further (opens in new tab)
  source_title TEXT NOT NULL DEFAULT '',     -- human-readable title of that source page
  deep_dive TEXT DEFAULT NULL                -- (legacy, unused)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,                  -- exam | review | weak
  score INTEGER,
  total INTEGER,
  duration_seconds INTEGER,
  overtime INTEGER NOT NULL DEFAULT 0, -- exam finished past the time limit
  session_id INTEGER,                  -- quiz_sessions.id this attempt came from
  answers_json TEXT,                   -- JSON: [{questionId, chosen, correct}] — chosen uses CANONICAL option indices
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,                  -- exam | review | weak
  seed INTEGER NOT NULL,               -- drives deterministic question/option shuffling (stable across resume)
  question_ids_json TEXT NOT NULL DEFAULT '[]', -- the question set frozen at session start
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS question_stats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,   -- consecutive correct answers; a question leaves the weak pool at streak >= 2
  last_answered_at TEXT,
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Lightweight migrations: add newer columns to databases created before they existed.
function addColumns(table, cols) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [name, ddl] of cols) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}
addColumns('questions', [
  ['source_url', "TEXT NOT NULL DEFAULT ''"],
  ['source_title', "TEXT NOT NULL DEFAULT ''"],
  ['correct_json', "TEXT NOT NULL DEFAULT ''"],
  ['qtype', "TEXT NOT NULL DEFAULT 'single'"]
]);
addColumns('topics', [
  ['material', "TEXT NOT NULL DEFAULT ''"],
  ['question_types', "TEXT NOT NULL DEFAULT 'single'"],
  ['is_shared', 'INTEGER NOT NULL DEFAULT 0']
]);
addColumns('attempts', [
  ['overtime', 'INTEGER NOT NULL DEFAULT 0'],
  ['session_id', 'INTEGER']
]);

// Backfill correct_json for questions created before question types existed.
db.exec(`UPDATE questions SET correct_json = '[' || correct_index || ']' WHERE correct_json = '' AND correct_index >= 0`);

// A server restart mid-generation would otherwise leave topics stuck on 'generating' forever.
db.exec(`UPDATE topics SET status = 'error', status_message = 'Generation was interrupted by a server restart — try again.' WHERE status = 'generating'`);

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
