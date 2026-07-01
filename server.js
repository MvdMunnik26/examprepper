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

app.use(express.json({ limit: '2mb' })); // pasted study material can be large
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
function isAdmin(userId) {
  const u = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
  return !!(u && u.is_admin);
}
// Owner (or admin) — required for managing a topic: settings, delete, generate, question bank
function getOwnedTopic(req, res, topicId) {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId ?? req.params.id);
  if (!topic) { res.status(404).json({ error: 'Topic not found' }); return null; }
  if (topic.user_id !== req.session.userId && !isAdmin(req.session.userId)) {
    res.status(403).json({ error: 'Not your topic' }); return null;
  }
  return topic;
}
// Owner, admin, or anyone if the topic is shared — enough to practice and view stats
function getAccessibleTopic(req, res, topicId) {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId ?? req.params.id);
  if (!topic) { res.status(404).json({ error: 'Topic not found' }); return null; }
  if (topic.user_id !== req.session.userId && !topic.is_shared && !isAdmin(req.session.userId)) {
    res.status(403).json({ error: 'Not your topic' }); return null;
  }
  return topic;
}

// ---------- deterministic shuffling ----------
// Question order and answer-option order are shuffled per quiz session using the
// session's stored seed, so a resumed session sees the exact same layout and the
// server can map submitted (shuffled) indices back to canonical ones for scoring.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const rand = mulberry32(seed | 0);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// perm[displayedIndex] = canonicalIndex. True/false and fill-in-the-blank are never shuffled.
function optionPerm(qtype, optionCount, seed, questionId) {
  const identity = Array.from({ length: optionCount }, (_, i) => i);
  if (qtype === 'truefalse' || qtype === 'fillblank' || optionCount < 2) return identity;
  return seededShuffle(identity, (seed + questionId * 101) | 0);
}
function parseQuestionRow(q) {
  return { ...q, options: JSON.parse(q.options_json || '[]'), correct: JSON.parse(q.correct_json || '[]') };
}
const normText = s => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.。]$/, '');

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
function weakCount(userId, topicId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM questions q
    JOIN question_stats s ON s.question_id = q.id AND s.user_id = ?
    WHERE q.topic_id = ? AND s.wrong_count > 0 AND s.streak < 2
  `).get(userId, topicId).n;
}
// Average of the last 3 mock-exam scores → readiness indicator
function readiness(userId, topicId) {
  const rows = db.prepare(`
    SELECT score * 100.0 / total AS pct FROM attempts
    WHERE topic_id = ? AND user_id = ? AND mode = 'exam' AND total > 0
    ORDER BY finished_at DESC, id DESC LIMIT 3
  `).all(topicId, userId);
  if (!rows.length) return null;
  return { avg: Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length), attempts: rows.length };
}

app.get('/api/topics', requireAuth, (req, res) => {
  const mine = db.prepare(`
    SELECT t.id, t.title, t.description, t.num_questions, t.difficulty, t.timer_minutes, t.status,
      t.status_message, t.question_types, t.is_shared, t.created_at,
      (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) AS question_count,
      (SELECT MAX(score * 100.0 / total) FROM attempts a WHERE a.topic_id = t.id AND a.user_id = t.user_id AND a.mode = 'exam' AND a.total > 0) AS best_score
    FROM topics t WHERE t.user_id = ? ORDER BY t.created_at DESC
  `).all(req.session.userId).map(t => ({
    ...t,
    weak_count: weakCount(req.session.userId, t.id),
    readiness: readiness(req.session.userId, t.id)
  }));
  const shared = db.prepare(`
    SELECT t.id, t.title, t.difficulty, t.timer_minutes, t.question_types, u.username AS owner,
      (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) AS question_count,
      (SELECT MAX(score * 100.0 / total) FROM attempts a WHERE a.topic_id = t.id AND a.user_id = ? AND a.mode = 'exam' AND a.total > 0) AS best_score
    FROM topics t JOIN users u ON u.id = t.user_id
    WHERE t.is_shared = 1 AND t.user_id != ? AND t.status = 'ready' ORDER BY t.created_at DESC
  `).all(req.session.userId, req.session.userId).map(t => ({
    ...t,
    weak_count: weakCount(req.session.userId, t.id),
    readiness: readiness(req.session.userId, t.id)
  }));
  res.json({ mine, shared });
});

app.post('/api/topics', requireAuth, (req, res) => {
  const { title, description, num_questions, difficulty, timer_minutes, material, question_types } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Topic title required' });
  const n = Math.min(Math.max(parseInt(num_questions) || 20, 5), 50);
  const diff = ['easy', 'medium', 'hard', 'mixed'].includes(difficulty) ? difficulty : 'mixed';
  const timer = Math.min(Math.max(parseInt(timer_minutes) || n, 5), 180);
  const qtypes = question_types === 'mixed' ? 'mixed' : 'single';
  const info = db.prepare(`
    INSERT INTO topics (user_id, title, description, num_questions, difficulty, timer_minutes, material, question_types)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.session.userId, title.trim(), (description || '').trim(), n, diff, timer,
    String(material || '').slice(0, 200000), qtypes);
  res.json(db.prepare('SELECT * FROM topics WHERE id = ?').get(info.lastInsertRowid));
});

// Single topic with everything the detail view needs
app.get('/api/topics/:id', requireAuth, (req, res) => {
  const topic = getAccessibleTopic(req, res); if (!topic) return;
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(topic.user_id);
  const isOwner = topic.user_id === req.session.userId || isAdmin(req.session.userId);
  res.json({
    id: topic.id, title: topic.title, description: topic.description,
    num_questions: topic.num_questions, difficulty: topic.difficulty, timer_minutes: topic.timer_minutes,
    status: topic.status, status_message: topic.status_message,
    question_types: topic.question_types, is_shared: topic.is_shared, created_at: topic.created_at,
    owner: owner ? owner.username : '?', is_owner: isOwner,
    material: isOwner ? topic.material : undefined,
    question_count: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE topic_id = ?').get(topic.id).n,
    weak_count: weakCount(req.session.userId, topic.id),
    readiness: readiness(req.session.userId, topic.id)
  });
});

app.put('/api/topics/:id/settings', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  const { num_questions, difficulty, timer_minutes, title, description, material, question_types, is_shared } = req.body;
  const n = Math.min(Math.max(parseInt(num_questions) || topic.num_questions, 5), 50);
  const diff = ['easy', 'medium', 'hard', 'mixed'].includes(difficulty) ? difficulty : topic.difficulty;
  const timer = Math.min(Math.max(parseInt(timer_minutes) || topic.timer_minutes, 5), 180);
  const qtypes = ['single', 'mixed'].includes(question_types) ? question_types : topic.question_types;
  db.prepare(`
    UPDATE topics SET num_questions = ?, difficulty = ?, timer_minutes = ?, title = ?, description = ?,
      material = ?, question_types = ?, is_shared = ? WHERE id = ?
  `).run(n, diff, timer, (title || topic.title).trim(),
    description !== undefined ? String(description).trim() : topic.description,
    material !== undefined ? String(material).slice(0, 200000) : topic.material,
    qtypes, is_shared !== undefined ? (is_shared ? 1 : 0) : topic.is_shared, topic.id);
  res.json(db.prepare('SELECT * FROM topics WHERE id = ?').get(topic.id));
});

app.delete('/api/topics/:id', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  db.prepare('DELETE FROM topics WHERE id = ?').run(topic.id);
  res.json({ ok: true });
});

// ---------- question generation (the AI part) ----------
// {append: true, count: N} adds N new questions (deduped against the bank);
// default regenerates the whole set from the topic settings.
app.post('/api/topics/:id/generate', requireAuth, async (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  if (topic.status === 'generating') return res.status(409).json({ error: 'Already generating' });

  const existingRows = db.prepare('SELECT question FROM questions WHERE topic_id = ?').all(topic.id);
  const append = !!req.body.append && existingRows.length > 0;
  const count = append
    ? Math.min(Math.max(parseInt(req.body.count) || 10, 1), 50)
    : topic.num_questions;

  const setStatus = (status, message) =>
    db.prepare('UPDATE topics SET status = ?, status_message = ? WHERE id = ?').run(status, message, topic.id);
  setStatus('generating', 'Contacting the AI…');
  res.json({ ok: true, status: 'generating' }); // respond immediately; client polls for status

  try {
    const questions = await ai.generateQuestions({
      title: topic.title, description: topic.description, material: topic.material,
      count, difficulty: topic.difficulty, questionTypes: topic.question_types,
      existing: append ? existingRows.map(r => r.question) : [],
      onProgress: (done, total) => setStatus('generating', `Generated ${done}/${total} questions…`)
    });
    setStatus('generating', 'Verifying source links…');
    await ai.verifySourceUrls(questions);

    const insert = db.prepare(`
      INSERT INTO questions (topic_id, question, options_json, correct_index, correct_json, qtype, difficulty, explanation, learn_more_query, source_url, source_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      if (!append) db.prepare('DELETE FROM questions WHERE topic_id = ?').run(topic.id);
      for (const q of questions) {
        insert.run(topic.id, q.question, JSON.stringify(q.options), q.correct_index,
          JSON.stringify(q.correct), q.qtype, q.difficulty, q.explanation,
          q.learn_more_query, q.source_url, q.source_title);
      }
      setStatus('ready', '');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } catch (err) {
    console.error('Generation failed:', err.message);
    setStatus('error', err.message);
  }
});

app.get('/api/topics/:id/status', requireAuth, (req, res) => {
  const topic = getAccessibleTopic(req, res); if (!topic) return;
  res.json({ status: topic.status, status_message: topic.status_message });
});

// ---------- quiz sessions ----------
// Starts (or resumes) a quiz. The server freezes the question set + shuffle seed in a
// session row: exam timing is measured server-side and a browser refresh resumes cleanly.
app.post('/api/topics/:id/quiz', requireAuth, (req, res) => {
  const topic = getAccessibleTopic(req, res); if (!topic) return;
  const mode = ['exam', 'review', 'weak'].includes(req.body.mode) ? req.body.mode : null;
  if (!mode) return res.status(400).json({ error: 'Invalid mode' });

  let sess = null, resumed = false;
  if (mode === 'weak') {
    // Weak-spot drills always start fresh — the weak pool changes after every attempt
    db.prepare("UPDATE quiz_sessions SET finished = 1 WHERE user_id = ? AND topic_id = ? AND mode = 'weak' AND finished = 0")
      .run(req.session.userId, topic.id);
    const ids = db.prepare(`
      SELECT q.id FROM questions q
      JOIN question_stats s ON s.question_id = q.id AND s.user_id = ?
      WHERE q.topic_id = ? AND s.wrong_count > 0 AND s.streak < 2
      ORDER BY s.streak ASC, s.wrong_count DESC LIMIT 50
    `).all(req.session.userId, topic.id).map(r => r.id);
    if (!ids.length) return res.status(400).json({ error: 'No weak questions right now — well done! Take a mock exam to find new ones.' });
    const seed = crypto.randomInt(1, 2 ** 31);
    const info = db.prepare('INSERT INTO quiz_sessions (user_id, topic_id, mode, seed, question_ids_json) VALUES (?, ?, ?, ?, ?)')
      .run(req.session.userId, topic.id, mode, seed, JSON.stringify(ids));
    sess = db.prepare('SELECT *, 0 AS elapsed FROM quiz_sessions WHERE id = ?').get(info.lastInsertRowid);
  } else {
    sess = db.prepare(`
      SELECT *, (strftime('%s','now') - strftime('%s',started_at)) AS elapsed
      FROM quiz_sessions WHERE user_id = ? AND topic_id = ? AND mode = ? AND finished = 0
      ORDER BY id DESC LIMIT 1
    `).get(req.session.userId, topic.id, mode);
    if (sess) {
      const stillThere = JSON.parse(sess.question_ids_json)
        .filter(id => db.prepare('SELECT id FROM questions WHERE id = ? AND topic_id = ?').get(id, topic.id));
      if (stillThere.length) { resumed = true; }
      else { db.prepare('UPDATE quiz_sessions SET finished = 1 WHERE id = ?').run(sess.id); sess = null; }
    }
    if (!sess) {
      const ids = db.prepare('SELECT id FROM questions WHERE topic_id = ?').all(topic.id).map(r => r.id);
      if (!ids.length) return res.status(400).json({ error: 'No questions yet — generate them first.' });
      const seed = crypto.randomInt(1, 2 ** 31);
      const info = db.prepare('INSERT INTO quiz_sessions (user_id, topic_id, mode, seed, question_ids_json) VALUES (?, ?, ?, ?, ?)')
        .run(req.session.userId, topic.id, mode, seed, JSON.stringify(ids));
      sess = db.prepare('SELECT *, 0 AS elapsed FROM quiz_sessions WHERE id = ?').get(info.lastInsertRowid);
    }
  }

  const rows = JSON.parse(sess.question_ids_json)
    .map(id => db.prepare('SELECT * FROM questions WHERE id = ? AND topic_id = ?').get(id, topic.id))
    .filter(Boolean).map(parseQuestionRow);
  const ordered = seededShuffle(rows, sess.seed);
  const questions = ordered.map(q => {
    const perm = optionPerm(q.qtype, q.options.length, sess.seed, q.id);
    const base = {
      id: q.id, qtype: q.qtype, question: q.question, difficulty: q.difficulty,
      options: perm.map(i => q.options[i]),
      choose: q.qtype === 'multi' ? q.correct.length : (q.qtype === 'fillblank' ? 0 : 1)
    };
    if (mode !== 'exam') { // review/weak need instant feedback; exams never expose answers to the browser
      base.correct = q.qtype === 'fillblank' ? q.correct : q.correct.map(c => perm.indexOf(c)).sort((a, b) => a - b);
      base.explanation = q.explanation;
      base.source_url = q.source_url; base.source_title = q.source_title;
      base.learn_more_query = q.learn_more_query;
    }
    return base;
  });

  res.json({
    session_id: sess.id, resumed, elapsed_seconds: sess.elapsed || 0, mode,
    topic: { id: topic.id, title: topic.title, timer_minutes: topic.timer_minutes },
    questions
  });
});

// Give up on an unfinished session (e.g. "Start over" on a resumed exam)
app.post('/api/quiz-sessions/:id/abandon', requireAuth, (req, res) => {
  const info = db.prepare('UPDATE quiz_sessions SET finished = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.session.userId);
  res.json({ ok: info.changes > 0 });
});

// ---------- attempts ----------
const upsertStat = db.prepare(`
  INSERT INTO question_stats (user_id, question_id, correct_count, wrong_count, streak, last_answered_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, question_id) DO UPDATE SET
    correct_count = correct_count + excluded.correct_count,
    wrong_count = wrong_count + excluded.wrong_count,
    streak = CASE WHEN excluded.correct_count > 0 THEN streak + 1 ELSE 0 END,
    last_answered_at = excluded.last_answered_at
`);

// Submit a quiz. Answers use the SHUFFLED option indices the client saw; the server
// remaps them to canonical indices via the session seed, scores everything, updates
// per-question stats, and returns full per-question detail for the results screen.
app.post('/api/topics/:id/attempts', requireAuth, (req, res) => {
  const topic = getAccessibleTopic(req, res); if (!topic) return;
  const sess = db.prepare(`
    SELECT *, (strftime('%s','now') - strftime('%s',started_at)) AS elapsed
    FROM quiz_sessions WHERE id = ? AND user_id = ? AND topic_id = ? AND finished = 0
  `).get(req.body.session_id, req.session.userId, topic.id);
  if (!sess) return res.status(400).json({ error: 'Quiz session not found or already submitted' });

  const answersByQid = {};
  for (const a of (req.body.answers || [])) answersByQid[a.questionId] = a.chosen;

  let score = 0, answeredCount = 0;
  const detailed = [], stored = [];
  const qids = JSON.parse(sess.question_ids_json);
  for (const qid of qids) {
    const row = db.prepare('SELECT * FROM questions WHERE id = ? AND topic_id = ?').get(qid, topic.id);
    if (!row) continue;
    const q = parseQuestionRow(row);
    const perm = optionPerm(q.qtype, q.options.length, sess.seed, q.id);

    const chosenRaw = answersByQid[qid];
    let chosenCanonical = null, correct = null;
    if (q.qtype === 'fillblank') {
      const text = typeof chosenRaw === 'string' ? chosenRaw.trim() : '';
      if (text) {
        chosenCanonical = text;
        correct = q.correct.some(ans => normText(ans) === normText(text));
      }
    } else {
      const arr = Array.isArray(chosenRaw) ? chosenRaw.filter(i => Number.isInteger(i) && i >= 0 && i < q.options.length) : [];
      if (arr.length) {
        chosenCanonical = [...new Set(arr)].map(i => perm[i]).sort((a, b) => a - b);
        correct = JSON.stringify(chosenCanonical) === JSON.stringify(q.correct);
      }
    }
    if (correct !== null) {
      answeredCount++;
      if (correct) score++;
      upsertStat.run(req.session.userId, q.id, correct ? 1 : 0, correct ? 0 : 1, correct ? 1 : 0);
    }
    stored.push({ questionId: q.id, chosen: chosenCanonical, correct });
    detailed.push({
      questionId: q.id, qtype: q.qtype, question: q.question, difficulty: q.difficulty,
      options: q.options, chosen: chosenCanonical, correct,
      correct_answer: q.correct, explanation: q.explanation,
      source_url: q.source_url, source_title: q.source_title, learn_more_query: q.learn_more_query
    });
  }

  const total = detailed.length;
  const duration = Math.max(0, sess.elapsed | 0);
  const overtime = sess.mode === 'exam' && duration > topic.timer_minutes * 60 + 90 ? 1 : 0;
  db.prepare(`
    INSERT INTO attempts (topic_id, user_id, mode, score, total, duration_seconds, overtime, session_id, answers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(topic.id, req.session.userId, sess.mode, score, total, duration, overtime, sess.id, JSON.stringify(stored));
  db.prepare('UPDATE quiz_sessions SET finished = 1 WHERE id = ?').run(sess.id);

  res.json({ score, total, answered: answeredCount, duration_seconds: duration, overtime, mode: sess.mode, detailed });
});

app.get('/api/topics/:id/attempts', requireAuth, (req, res) => {
  const topic = getAccessibleTopic(req, res); if (!topic) return;
  res.json(db.prepare(`
    SELECT id, mode, score, total, duration_seconds, overtime, finished_at
    FROM attempts WHERE topic_id = ? AND user_id = ? ORDER BY finished_at DESC, id DESC LIMIT 50
  `).all(topic.id, req.session.userId));
});

// Full detail of one past attempt, joined with the questions as they exist now
app.get('/api/attempts/:id', requireAuth, (req, res) => {
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  if (attempt.user_id !== req.session.userId && !isAdmin(req.session.userId)) {
    return res.status(403).json({ error: 'Not your attempt' });
  }
  const topic = db.prepare('SELECT id, title FROM topics WHERE id = ?').get(attempt.topic_id);
  const items = JSON.parse(attempt.answers_json || '[]').map(a => {
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(a.questionId);
    if (!row) return { questionId: a.questionId, missing: true, chosen: a.chosen, correct: a.correct };
    const q = parseQuestionRow(row);
    return {
      questionId: q.id, qtype: q.qtype, question: q.question, difficulty: q.difficulty,
      options: q.options, chosen: a.chosen, correct: a.correct,
      correct_answer: q.correct, explanation: q.explanation,
      source_url: q.source_url, source_title: q.source_title, learn_more_query: q.learn_more_query
    };
  });
  res.json({
    attempt: { id: attempt.id, mode: attempt.mode, score: attempt.score, total: attempt.total,
      duration_seconds: attempt.duration_seconds, overtime: attempt.overtime, finished_at: attempt.finished_at },
    topic, items
  });
});

// Best mock-exam score per user — shown on shared topics
app.get('/api/topics/:id/leaderboard', requireAuth, (req, res) => {
  const topic = getAccessibleTopic(req, res); if (!topic) return;
  if (!topic.is_shared && topic.user_id !== req.session.userId && !isAdmin(req.session.userId)) {
    return res.status(403).json({ error: 'Leaderboard is only available on shared topics' });
  }
  res.json(db.prepare(`
    SELECT u.username, ROUND(MAX(a.score * 100.0 / a.total)) AS best_pct, COUNT(*) AS attempts
    FROM attempts a JOIN users u ON u.id = a.user_id
    WHERE a.topic_id = ? AND a.mode = 'exam' AND a.total > 0
    GROUP BY a.user_id ORDER BY best_pct DESC, attempts ASC LIMIT 20
  `).all(topic.id));
});

// ---------- question bank (owner only) ----------
app.get('/api/topics/:id/bank', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  res.json(db.prepare('SELECT * FROM questions WHERE topic_id = ? ORDER BY id').all(topic.id)
    .map(parseQuestionRow)
    .map(q => ({ id: q.id, qtype: q.qtype, question: q.question, options: q.options, correct: q.correct,
      difficulty: q.difficulty, explanation: q.explanation, source_url: q.source_url,
      source_title: q.source_title, learn_more_query: q.learn_more_query })));
});

app.post('/api/topics/:id/bank', requireAuth, (req, res) => {
  const topic = getOwnedTopic(req, res); if (!topic) return;
  const q = ai.normalizeQuestion(req.body);
  if (!q) return res.status(400).json({ error: 'Invalid question — check options and correct answer(s)' });
  const info = db.prepare(`
    INSERT INTO questions (topic_id, question, options_json, correct_index, correct_json, qtype, difficulty, explanation, learn_more_query, source_url, source_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(topic.id, q.question, JSON.stringify(q.options), q.correct_index, JSON.stringify(q.correct),
    q.qtype, q.difficulty, q.explanation, q.learn_more_query, q.source_url, q.source_title);
  if (topic.status !== 'ready') db.prepare("UPDATE topics SET status = 'ready', status_message = '' WHERE id = ?").run(topic.id);
  res.json({ id: info.lastInsertRowid, ...q });
});

app.put('/api/questions/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Question not found' });
  const topic = getOwnedTopic(req, res, row.topic_id); if (!topic) return;
  const q = ai.normalizeQuestion(req.body);
  if (!q) return res.status(400).json({ error: 'Invalid question — check options and correct answer(s)' });
  db.prepare(`
    UPDATE questions SET question = ?, options_json = ?, correct_index = ?, correct_json = ?, qtype = ?,
      difficulty = ?, explanation = ?, learn_more_query = ?, source_url = ?, source_title = ? WHERE id = ?
  `).run(q.question, JSON.stringify(q.options), q.correct_index, JSON.stringify(q.correct), q.qtype,
    q.difficulty, q.explanation, q.learn_more_query, q.source_url, q.source_title, row.id);
  res.json({ id: row.id, ...q });
});

app.delete('/api/questions/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Question not found' });
  const topic = getOwnedTopic(req, res, row.topic_id); if (!topic) return;
  db.prepare('DELETE FROM questions WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ---------- follow-up questions to the AI tutor ----------
app.post('/api/questions/:id/ask', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Question not found' });
  const topic = getAccessibleTopic(req, res, row.topic_id); if (!topic) return;

  const userQuestion = String(req.body.question || '').trim().slice(0, 500);
  if (!userQuestion) return res.status(400).json({ error: 'Ask something first' });
  const history = (Array.isArray(req.body.history) ? req.body.history : []).slice(-6)
    .map(h => ({ q: String(h.q || '').slice(0, 500), a: String(h.a || '').slice(0, 2000) }))
    .filter(h => h.q && h.a);

  const q = parseQuestionRow(row);
  const correctText = q.qtype === 'fillblank'
    ? q.correct.join(' / ')
    : q.correct.map(i => `${'ABCDEF'[i]}. ${q.options[i]}`).join(' and ');
  try {
    const answer = await ai.askFollowUp({
      topicTitle: topic.title, question: q.question, options: q.options,
      correctText, explanation: q.explanation, history, userQuestion
    });
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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
    SELECT t.id, t.title, t.status, t.num_questions, t.difficulty, t.is_shared, t.created_at, u.username,
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
