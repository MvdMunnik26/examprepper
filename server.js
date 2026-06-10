// server.js — ExamPrepper backend
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Persist a session secret so logins survive server restarts
let sessionSecret = getSetting('session_secret');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  setSetting('session_secret', sessionSecret);
}
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
}));

// ---------- middleware ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}
// Load a topic and verify the current user owns it (admins may access all)
function getOwnedTopic(req, res) {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.id);
  if (!topic) { res.status(404).json({ error: 'Topic not found' }); return null; }
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (topic.user_id !== req.session.userId && !user.is_admin) {
    res.status(403).json({ error: 'Not your topic' }); return null;
  }
  return topic;
}

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 2 || password.length < 6) {
    return res.status(400).json({ error: 'Username (min 2 chars) and password (min 6 chars) required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const isFirstUser = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username.trim(), hash, isFirstUser ? 1 : 0);
  req.session.userId = info.lastInsertRowid;
  res.json({ id: info.lastInsertRowid, username: username.trim(), is_admin: isFirstUser ? 1 : 0 });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username, is_admin: user.is_admin });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  const user = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(req.session.userId);
  res.json(user || null);
});

// ---------- topics ----------
app.get('/api/topics', requireAuth, (req, res) => {
  const topics = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) AS question_count,
      (SELECT MAX(score * 100.0 / total) FROM attempts a WHERE a.topic_id = t.id AND a.mode = 'exam') AS best_score
    FROM topics t WHERE t.user_id = ? ORDER BY t.created_at DESC
  `).all(req.session.userId);
  res.json(topics);
});

app.post('/api/topics', requireAuth, (req, res) => {
  const { title, description, num_questions, difficulty, timer_minutes } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Topic title required' });
  const n = Math.min(Math.max(parseInt(num_questions) || 20, 5), 50);
  const diff = ['easy', 'medium', 'hard', 'mixed'].includes(difficulty) ? difficulty : 'mixed';
  const timer = Math.min(Math.max(parseInt(timer_minutes) || n, 5), 180);
  const info = db.prepare(`
    INSERT INTO topics (user_id, title, description, num_questions, difficulty, timer_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.session.userId, title.trim(), (description || '').trim(), n, diff, timer);
  res.json(db.prepare('SELECT * FROM topics WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/topics/:id/settings', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  const { num_questions, difficulty, timer_minutes, title, description } = req.body;
  const n = Math.min(Math.max(parseInt(num_questions) || topic.num_questions, 5), 50);
  const diff = ['easy', 'medium', 'hard', 'mixed'].includes(difficulty) ? difficulty : topic.difficulty;
  const timer = Math.min(Math.max(parseInt(timer_minutes) || topic.timer_minutes, 5), 180);
  db.prepare(`
    UPDATE topics SET num_questions = ?, difficulty = ?, timer_minutes = ?, title = ?, description = ? WHERE id = ?
  `).run(n, diff, timer, (title || topic.title).trim(), description !== undefined ? description.trim() : topic.description, topic.id);
  res.json(db.prepare('SELECT * FROM topics WHERE id = ?').get(topic.id));
});

app.delete('/api/topics/:id', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  db.prepare('DELETE FROM topics WHERE id = ?').run(topic.id);
  res.json({ ok: true });
});

// ---------- question generation (the AI part) ----------
app.post('/api/topics/:id/generate', requireAuth, async (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  if (topic.status === 'generating') return res.status(409).json({ error: 'Already generating' });

  db.prepare("UPDATE topics SET status = 'generating', status_message = '' WHERE id = ?").run(topic.id);
  res.json({ ok: true, status: 'generating' }); // respond immediately; client polls for status

  try {
    const questions = await ai.generateQuestions(topic.title, topic.description, topic.num_questions, topic.difficulty);
    const insert = db.prepare(`
      INSERT INTO questions (topic_id, question, options_json, correct_index, difficulty, explanation, learn_more_query, source_url, source_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM questions WHERE topic_id = ?').run(topic.id);
      for (const q of questions) {
        insert.run(topic.id, q.question, JSON.stringify(q.options), q.correct_index, q.difficulty, q.explanation, q.learn_more_query, q.source_url, q.source_title);
      }
      db.prepare("UPDATE topics SET status = 'ready', status_message = '' WHERE id = ?").run(topic.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } catch (err) {
    console.error('Generation failed:', err.message);
    db.prepare("UPDATE topics SET status = 'error', status_message = ? WHERE id = ?").run(err.message, topic.id);
  }
});

app.get('/api/topics/:id/status', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  res.json({ status: topic.status, status_message: topic.status_message });
});

// Questions for taking a quiz. correct_index/explanation are included because
// review mode needs instant feedback; exam mode scoring is still done server-side.
app.get('/api/topics/:id/questions', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  const questions = db.prepare('SELECT * FROM questions WHERE topic_id = ?').all(topic.id)
    .map(q => ({ ...q, options: JSON.parse(q.options_json), options_json: undefined }));
  // Shuffle question order per session
  for (let i = questions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }
  res.json({ topic: { id: topic.id, title: topic.title, timer_minutes: topic.timer_minutes }, questions });
});

// ---------- attempts ----------
app.post('/api/topics/:id/attempts', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  const { mode, answers, duration_seconds } = req.body; // answers: [{questionId, chosenIndex}]
  if (!['exam', 'review'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });

  let score = 0;
  const detailed = [];
  for (const a of (answers || [])) {
    const q = db.prepare('SELECT * FROM questions WHERE id = ? AND topic_id = ?').get(a.questionId, topic.id);
    if (!q) continue;
    const correct = q.correct_index === a.chosenIndex;
    if (correct) score++;
    detailed.push({ questionId: q.id, chosenIndex: a.chosenIndex, correct });
  }
  const total = (answers || []).length;
  db.prepare(`
    INSERT INTO attempts (topic_id, user_id, mode, score, total, duration_seconds, answers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(topic.id, req.session.userId, mode, score, total, duration_seconds || null, JSON.stringify(detailed));
  res.json({ score, total, detailed });
});

app.get('/api/topics/:id/attempts', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  res.json(db.prepare(
    'SELECT id, mode, score, total, duration_seconds, finished_at FROM attempts WHERE topic_id = ? AND user_id = ? ORDER BY finished_at DESC LIMIT 20'
  ).all(topic.id, req.session.userId));
});

// Deep-dive is now a stored source_url returned with each question (see /questions),
// opened directly in a new browser tab — no on-the-fly generation endpoint needed.

// ---------- admin ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.created_at,
      (SELECT COUNT(*) FROM topics t WHERE t.user_id = u.id) AS topic_count,
      (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id) AS attempt_count
    FROM users u ORDER BY u.created_at
  `).all());
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { is_admin, password } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (is_admin !== undefined) {
    if (target.id === req.session.userId && !is_admin) {
      return res.status(400).json({ error: "You can't remove your own admin rights" });
    }
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, target.id);
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), target.id);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: "You can't delete yourself" });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/topics', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT t.id, t.title, t.status, t.num_questions, t.difficulty, t.created_at, u.username,
      (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) AS question_count
    FROM topics t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC
  `).all());
});

app.delete('/api/admin/topics/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM topics WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const key = ai.getApiKey();
  res.json({ api_key_set: !!key, api_key_hint: key ? key.slice(0, 10) + '…' : null });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { anthropic_api_key } = req.body;
  if (anthropic_api_key !== undefined) setSetting('anthropic_api_key', anthropic_api_key.trim());
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`ExamPrepper running → http://localhost:${PORT}`);
});
