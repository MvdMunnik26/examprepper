// ExamPrepper frontend — a small single-page app, no frameworks
let me = null;            // current user
let quiz = null;          // active quiz state
let pollTimers = {};      // topic generation polling
let askThreads = {};      // per-question follow-up conversations (client-side only)
let bankCache = {};       // question bank rows by id, for the editor

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LETTERS = 'ABCDEF';

// ---------- api helper ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  for (const id of ['themeBtn', 'themeBtnLanding']) {
    const el = document.getElementById(id);
    if (el) el.textContent = t === 'dark' ? '☀️' : '🌙';
  }
}
const toggleTheme = () =>
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
document.getElementById('themeBtn').onclick = toggleTheme;
const landingThemeBtn = document.getElementById('themeBtnLanding');
if (landingThemeBtn) landingThemeBtn.onclick = toggleTheme;
applyTheme(localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- quiz state persistence (survives refresh; timer stays server-side) ----------
const stateKey = id => `ep_s${id}`;
function saveQuizState() {
  if (!quiz) return;
  localStorage.setItem(stateKey(quiz.sessionId), JSON.stringify({
    answers: quiz.answers, flagged: quiz.flagged, revealed: quiz.revealed, current: quiz.current, ts: Date.now()
  }));
}
function clearQuizState(sessionId) { localStorage.removeItem(stateKey(sessionId)); }
// prune saved sessions older than 14 days
for (const k of Object.keys(localStorage)) {
  if (k.startsWith('ep_s')) {
    try { if ((JSON.parse(localStorage.getItem(k)).ts || 0) < Date.now() - 14 * 864e5) localStorage.removeItem(k); }
    catch { localStorage.removeItem(k); }
  }
}

// ---------- "explore further" source link ----------
function sourceLink(q) {
  const hasUrl = q.source_url && /^https?:\/\//i.test(q.source_url);
  const url = hasUrl
    ? q.source_url
    : 'https://duckduckgo.com/?q=' + encodeURIComponent(q.learn_more_query || q.question || '');
  const label = hasUrl
    ? `📚 Read more: ${esc(q.source_title || q.source_url)}`
    : '📚 Explore this topic on the web';
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
}

// ---------- router ----------
const VIEW_TITLES = {
  dashboard: 'My topics', topic: 'Topic details', admin: 'Admin', quiz: 'Practice',
  bank: 'Question bank', attempt: 'Attempt review'
};
async function go(view, arg) {
  Object.values(pollTimers).forEach(clearInterval); pollTimers = {};
  if (quiz?.timerInterval) clearInterval(quiz.timerInterval);
  document.removeEventListener('keydown', quizKeys);
  if (view !== 'results') quiz = null;
  document.title = `${VIEW_TITLES[view] || 'ExamPrepper'} · ExamPrepper`;
  window.scrollTo(0, 0);
  try {
    if (view === 'dashboard') return await renderDashboard();
    if (view === 'topic') return await renderTopicDetail(arg.topicId);
    if (view === 'admin') return await renderAdmin();
    if (view === 'quiz') return await startQuiz(arg.topicId, arg.mode);
    if (view === 'bank') return await renderBank(arg.topicId);
    if (view === 'attempt') return await renderAttemptDetail(arg.attemptId);
  } catch (e) { toast(e.message); }
}

// ---------- auth & landing ----------
// Logged out → the static landing page is visible with the auth card embedded in its hero.
// Logged in → landing is hidden and the SPA takes over.
function showLanding(mode = 'login') {
  document.documentElement.classList.remove('app-mode');
  localStorage.removeItem('ep_auth');
  document.getElementById('header').style.display = 'none';
  document.getElementById('landing').style.display = '';
  $app.innerHTML = '';
  document.title = 'ExamPrepper — AI practice exams, mock tests & weak-spot drills';
  renderAuth(mode);
}

function renderAuth(mode = 'login') {
  const slot = document.getElementById('authCard');
  slot.innerHTML = `
    <h2 style="margin-top:0">${mode === 'login' ? 'Log in' : 'Create your free account'}</h2>
    <label for="username">Username</label><input id="username" autocomplete="username">
    <label for="password">Password</label><input id="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
    <button class="primary" id="authGo" style="width:100%;margin-top:20px;padding:12px">${mode === 'login' ? 'Log in' : 'Create account'}</button>
    <div class="auth-toggle">${mode === 'login'
      ? `No account yet? <a href="#get-started" id="authSwitch">Register</a>`
      : `Already registered? <a href="#get-started" id="authSwitch">Log in</a>`}</div>`;
  slot.querySelector('#authSwitch').onclick = e => { e.preventDefault(); renderAuth(mode === 'login' ? 'register' : 'login'); };
  const submit = async () => {
    try {
      me = await api(mode === 'login' ? '/api/login' : '/api/register', {
        method: 'POST',
        body: { username: slot.querySelector('#username').value, password: slot.querySelector('#password').value }
      });
      onLoggedIn();
    } catch (e) { toast(e.message); }
  };
  slot.querySelector('#authGo').onclick = submit;
  slot.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
}

function onLoggedIn() {
  document.documentElement.classList.add('app-mode');
  localStorage.setItem('ep_auth', '1');
  document.getElementById('landing').style.display = 'none';
  document.getElementById('header').style.display = 'flex';
  document.getElementById('whoami').textContent = me.username;
  document.getElementById('adminBtn').style.display = me.is_admin ? '' : 'none';
  go('dashboard');
}

async function logout() { await api('/api/logout', { method: 'POST' }); me = null; showLanding(); }

// ---------- dashboard ----------
function readinessBadge(r) {
  if (!r) return '';
  const [cls, label] = r.avg >= 80 ? ['ready', '🏆 exam ready'] : r.avg >= 60 ? ['medium', '📈 getting there'] : ['error', '💪 keep practicing'];
  return `<span class="badge ${cls}" title="Average of last ${r.attempts} mock exam(s): ${r.avg}%">${label}</span>`;
}

async function renderDashboard() {
  const { mine, shared } = await api('/api/topics');
  $app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <h1 style="margin:0">My exam topics</h1>
      <button class="primary" onclick="openTopicModal()">+ New topic</button>
    </div>
    ${mine.length === 0
      ? `<div class="empty"><p style="font-size:2.4rem;margin:0">📚</p><p>No topics yet. Add your first exam topic and I'll research it and build a question set for you.</p></div>`
      : `<div class="topic-grid">${mine.map(t => topicCard(t, false)).join('')}</div>`}
    ${shared.length ? `
      <h2 style="margin-top:40px">Shared by others</h2>
      <div class="topic-grid">${shared.map(t => topicCard(t, true)).join('')}</div>` : ''}`;
  mine.filter(t => t.status === 'generating').forEach(t => pollTopic(t.id, renderDashboard));
}

function topicCard(t, isShared) {
  // Practicing only needs questions in the bank — a failed (re)generation shouldn't block it
  const ready = t.status !== 'generating' && t.question_count > 0;
  return `
  <div class="card topic-card" id="topic-${t.id}">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
      <h3><a href="#" onclick="go('topic',{topicId:${t.id}});return false" style="color:inherit;text-decoration:none">${esc(t.title)}</a></h3>
      <span style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
        ${isShared ? `<span class="badge shared">👥 shared</span>` : `<span class="badge ${t.status}">${t.status === 'generating' ? '<span class="spinner"></span>' : ''}${t.status}</span>`}
        ${readinessBadge(t.readiness)}
      </span>
    </div>
    <div class="meta">
      ${isShared ? `by <strong>${esc(t.owner)}</strong> · ` : ''}${t.question_count || 0} questions · ${esc(t.difficulty)} · ${t.timer_minutes} min
      ${t.best_score != null ? ` · best: ${Math.round(t.best_score)}%` : ''}
      ${t.weak_count ? ` · <span style="color:var(--amber)">🎯 ${t.weak_count} weak</span>` : ''}
    </div>
    ${t.status === 'error' ? `<div class="meta" style="color:var(--red)">⚠ ${esc(t.status_message)}</div>` : ''}
    ${t.status === 'generating' ? `<div class="meta">${esc(t.status_message || '')}</div>` : ''}
    <div class="btn-row">
      ${ready ? `
        <button class="primary" onclick="go('quiz',{topicId:${t.id},mode:'exam'})">⏱ Mock exam</button>
        <button onclick="go('quiz',{topicId:${t.id},mode:'review'})">📖 Review</button>
        ${t.weak_count ? `<button onclick="go('quiz',{topicId:${t.id},mode:'weak'})" title="Drill the questions you keep getting wrong">🎯 Weak spots</button>` : ''}` : ''}
      ${!isShared && t.status !== 'generating' && !ready ? `
        <button onclick="generateQuestions(${t.id})">✨ Generate questions</button>` : ''}
      <button class="ghost" onclick="go('topic',{topicId:${t.id}})" title="Details & history" aria-label="Details and history">📊</button>
      ${!isShared ? `<button class="ghost" onclick="openTopicModal(${t.id})" title="Settings" aria-label="Topic settings">⚙️</button>` : ''}
    </div>
  </div>`;
}

async function generateQuestions(topicId, opts = {}) {
  try {
    await api(`/api/topics/${topicId}/generate`, { method: 'POST', body: opts });
    toast(opts.append ? 'Generating extra questions…' : 'Researching topic and generating questions…');
    return true;
  } catch (e) { toast(e.message); return false; }
}

function pollTopic(topicId, onDone) {
  if (pollTimers[topicId]) clearInterval(pollTimers[topicId]);
  pollTimers[topicId] = setInterval(async () => {
    try {
      const s = await api(`/api/topics/${topicId}/status`);
      const card = document.querySelector(`#topic-${topicId} .meta:last-of-type`);
      if (s.status === 'generating') {
        const msgEl = document.getElementById(`gen-msg-${topicId}`);
        if (msgEl) msgEl.textContent = s.status_message || 'Working…';
        return;
      }
      clearInterval(pollTimers[topicId]); delete pollTimers[topicId];
      toast(s.status === 'ready' ? 'Questions ready! 🎉' : `Generation failed: ${s.status_message}`);
      if (onDone) onDone();
    } catch { clearInterval(pollTimers[topicId]); }
  }, 3000);
}

// ---------- topic create/settings modal ----------
async function openTopicModal(topicId) {
  let t = { title: '', description: '', material: '', num_questions: 20, difficulty: 'mixed', timer_minutes: 20, question_types: 'single', is_shared: 0 };
  if (topicId) t = await api(`/api/topics/${topicId}`);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="card modal">
      <h2 style="margin-top:0">${topicId ? 'Topic settings' : 'New exam topic'}</h2>
      <label>Topic title</label>
      <input id="m-title" value="${esc(t.title)}" placeholder="e.g. AWS Solutions Architect, Dutch history, TCP/IP networking">
      <label>Extra context (optional)</label>
      <textarea id="m-desc" rows="2" placeholder="Focus areas, exam level, what to emphasise…">${esc(t.description)}</textarea>
      <label>Your study material (optional) — questions will be based on it</label>
      <textarea id="m-material" rows="4" placeholder="Paste your notes, syllabus or textbook chapter here… (or load a .txt/.md file below)">${esc(t.material || '')}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:.8rem;color:var(--text-dim)">
        <input type="file" id="m-file" accept=".txt,.md,.markdown,text/plain" style="width:auto;padding:4px;background:none;border:none">
        <span id="m-matcount"></span>
      </div>
      <label>Number of questions (5–50)</label>
      <input id="m-num" type="number" min="5" max="50" value="${t.num_questions}">
      <label>Difficulty</label>
      <select id="m-diff">
        ${['mixed', 'easy', 'medium', 'hard'].map(d => `<option value="${d}" ${t.difficulty === d ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}
      </select>
      <label>Question types</label>
      <select id="m-qtypes">
        <option value="single" ${t.question_types === 'single' ? 'selected' : ''}>Multiple choice only</option>
        <option value="mixed" ${t.question_types === 'mixed' ? 'selected' : ''}>Mixed — adds multi-select, true/false & fill-in-the-blank</option>
      </select>
      <label>Mock exam timer (minutes)</label>
      <input id="m-timer" type="number" min="5" max="180" value="${t.timer_minutes}">
      ${topicId ? `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:16px">
        <input type="checkbox" id="m-shared" style="width:auto" ${t.is_shared ? 'checked' : ''}>
        Share this topic — other users can practice it and appear on its leaderboard
      </label>` : ''}
      <div style="display:flex;gap:10px;margin-top:22px;justify-content:flex-end;flex-wrap:wrap">
        ${topicId ? `<button class="danger" id="m-delete">Delete topic</button>` : ''}
        <button id="m-cancel">Cancel</button>
        <button class="primary" id="m-save">${topicId ? 'Save settings' : 'Create topic'}</button>
      </div>
      ${topicId ? `<p style="font-size:.82rem;color:var(--text-dim)">Question count, difficulty, types and material apply the next time you generate questions.</p>` : ''}
    </div>`;
  document.body.appendChild(backdrop);
  const $ = sel => backdrop.querySelector(sel);
  const updateCount = () => { const n = $('#m-material').value.length; $('#m-matcount').textContent = n ? `${n.toLocaleString()} characters` : ''; };
  updateCount();
  $('#m-material').addEventListener('input', updateCount);
  $('#m-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const cur = $('#m-material').value;
      $('#m-material').value = (cur ? cur + '\n\n' : '') + reader.result;
      updateCount(); toast(`Added ${file.name}`);
    };
    reader.readAsText(file);
  });
  backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
  $('#m-cancel').onclick = () => backdrop.remove();
  if (topicId) $('#m-delete').onclick = async () => {
    if (!confirm('Delete this topic and all its questions and results?')) return;
    await api(`/api/topics/${topicId}`, { method: 'DELETE' });
    backdrop.remove(); toast('Topic deleted'); go('dashboard');
  };
  $('#m-save').onclick = async () => {
    const body = {
      title: $('#m-title').value,
      description: $('#m-desc').value,
      material: $('#m-material').value,
      num_questions: $('#m-num').value,
      difficulty: $('#m-diff').value,
      question_types: $('#m-qtypes').value,
      timer_minutes: $('#m-timer').value
    };
    if (topicId) body.is_shared = $('#m-shared').checked;
    try {
      if (topicId) { await api(`/api/topics/${topicId}/settings`, { method: 'PUT', body }); toast('Settings saved'); }
      else {
        const created = await api('/api/topics', { method: 'POST', body });
        toast('Topic created — generating questions…');
        api(`/api/topics/${created.id}/generate`, { method: 'POST', body: {} }).catch(e => toast(e.message));
      }
      backdrop.remove(); go('dashboard');
    } catch (e) { toast(e.message); }
  };
}

// ---------- quiz ----------
async function startQuiz(topicId, mode) {
  let data;
  try { data = await api(`/api/topics/${topicId}/quiz`, { method: 'POST', body: { mode } }); }
  catch (e) { toast(e.message); return go('dashboard'); }
  if (!data.questions.length) { toast('No questions yet — generate them first.'); return go('dashboard'); }

  quiz = {
    sessionId: data.session_id, topicId, mode, topic: data.topic, questions: data.questions,
    current: 0, answers: {}, flagged: {}, revealed: {}, resumed: data.resumed,
    secondsLeft: data.topic.timer_minutes * 60 - (data.elapsed_seconds || 0), timerInterval: null
  };
  // Restore saved progress after a refresh / accidental navigation
  if (data.resumed) {
    try {
      const saved = JSON.parse(localStorage.getItem(stateKey(data.session_id)));
      if (saved) {
        quiz.answers = saved.answers || {}; quiz.flagged = saved.flagged || {};
        quiz.revealed = saved.revealed || {}; quiz.current = Math.min(saved.current || 0, quiz.questions.length - 1);
      }
    } catch { /* corrupted state — start clean */ }
  }

  document.addEventListener('keydown', quizKeys);

  if (mode === 'exam') {
    if (quiz.secondsLeft <= 0) { toast("Time was already up — submitting your saved answers."); return finishQuiz(); }
    quiz.timerInterval = setInterval(() => {
      quiz.secondsLeft--;
      const el = document.getElementById('timer');
      if (el) {
        el.textContent = fmtTime(quiz.secondsLeft);
        el.classList.toggle('low', quiz.secondsLeft <= 60);
      }
      if (quiz.secondsLeft <= 0) { toast("Time's up!"); finishQuiz(); }
    }, 1000);
  }
  renderQuestion();
  if (data.resumed) toast(mode === 'exam' ? `Resumed — ${fmtTime(quiz.secondsLeft)} left` : 'Resumed where you left off');
}

const fmtTime = s => `${Math.floor(Math.max(s, 0) / 60)}:${String(Math.max(s, 0) % 60).padStart(2, '0')}`;

function quizKeys(e) {
  if (!quiz) return;
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const q = quiz.questions[quiz.current];
  if (e.key === 'Enter') {
    if (quiz.mode !== 'exam' && !quiz.revealed[q.id] && canCheck(q)) { e.preventDefault(); checkAnswer(q.id); return; }
    if (!inInput && quiz.current < quiz.questions.length - 1) { e.preventDefault(); moveQuestion(1); }
    return;
  }
  if (inInput) return;
  if (e.key === 'ArrowLeft') return moveQuestion(-1);
  if (e.key === 'ArrowRight') return moveQuestion(1);
  if (e.key.toLowerCase() === 'f' && quiz.mode === 'exam') return toggleFlag(q.id);
  const n = parseInt(e.key);
  if (n >= 1 && n <= (q.options?.length || 0)) chooseOption(q.id, n - 1);
}

function canCheck(q) {
  const a = quiz.answers[q.id];
  if (q.qtype === 'fillblank') return typeof a === 'string' && a.trim().length > 0;
  if (q.qtype === 'multi') return Array.isArray(a) && a.length > 0;
  return false; // single/truefalse reveal on click
}

function abandonQuiz() {
  const sid = quiz.sessionId;
  api(`/api/quiz-sessions/${sid}/abandon`, { method: 'POST' }).catch(() => {});
  clearQuizState(sid);
  go('dashboard');
}

function renderQuestion() {
  const q = quiz.questions[quiz.current];
  const chosen = quiz.answers[q.id];
  const revealed = quiz.mode !== 'exam' && quiz.revealed[q.id];
  const answeredCount = quiz.questions.filter(x => isAnswered(x)).length;
  const last = quiz.current === quiz.questions.length - 1;
  const modeLabel = quiz.mode === 'exam' ? 'Mock exam' : quiz.mode === 'weak' ? 'Weak-spot drill' : 'Review mode';

  $app.innerHTML = `
    <div class="quiz-top">
      <div>
        <div class="crumb">${esc(quiz.topic.title)} · ${modeLabel}${quiz.resumed ? ' · <em>resumed</em>' : ''}</div>
        <strong>Question ${quiz.current + 1} of ${quiz.questions.length}</strong>
        <span class="badge ${q.difficulty}" style="margin-left:8px">${q.difficulty}</span>
        ${qtypeBadge(q.qtype)}
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${quiz.mode === 'exam'
          ? `<div class="timer ${quiz.secondsLeft <= 60 ? 'low' : ''}" id="timer">${fmtTime(quiz.secondsLeft)}</div>
             <button class="ghost" onclick="if(confirm('Leave the exam? Your answers are saved and the timer keeps running — resume from the dashboard.')){clearInterval(quiz.timerInterval);go('dashboard')}" title="Save & exit" aria-label="Save and exit exam">⏸</button>`
          : `<button class="ghost" onclick="if(confirm('Leave this session? Progress will be discarded.'))abandonQuiz()">✕ Exit</button>`}
      </div>
    </div>
    <div class="progress-bar"><div style="width:${(quiz.current + 1) / quiz.questions.length * 100}%"></div></div>
    ${quiz.mode === 'exam' ? navigator() : ''}
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <h2 style="margin-top:0;font-size:1.15rem">${esc(q.question)}</h2>
        ${quiz.mode === 'exam' ? `<button class="ghost flag-btn ${quiz.flagged[q.id] ? 'on' : ''}" onclick="toggleFlag(${q.id})" title="Flag for review (F)" aria-label="Flag question for review">🚩</button>` : ''}
      </div>
      ${q.qtype === 'multi' ? `<p class="choose-hint">Select ${q.choose} answers</p>` : ''}
      ${questionBody(q, chosen, revealed)}
      ${revealed ? revealBox(q, chosen) : ''}
      ${!revealed && quiz.mode !== 'exam' && (q.qtype === 'multi' || q.qtype === 'fillblank')
        ? `<button class="primary" style="margin-top:14px" onclick="checkAnswer(${q.id})" ${canCheck(q) ? '' : 'disabled'} id="checkBtn">Check answer</button>` : ''}
    </div>
    <div class="quiz-nav">
      <button onclick="moveQuestion(-1)" ${quiz.current === 0 ? 'disabled' : ''}>← Previous</button>
      <div style="display:flex;gap:10px">
        ${quiz.mode === 'exam' ? `
          <span style="align-self:center;color:var(--text-dim);font-size:.88rem">${answeredCount}/${quiz.questions.length} answered</span>
          <button class="primary" onclick="confirmSubmit(${answeredCount})">Submit exam</button>` : ''}
        ${!last ? `<button class="${quiz.mode !== 'exam' && revealed ? 'primary' : ''}" onclick="moveQuestion(1)">Next →</button>` : ''}
        ${last && quiz.mode !== 'exam' ? `<button class="primary" onclick="finishQuiz()">Finish session</button>` : ''}
      </div>
    </div>
    <p class="kbd-hint">⌨ <kbd>1</kbd>–<kbd>${Math.max(q.options?.length || 4, 2)}</kbd> answer · <kbd>←</kbd><kbd>→</kbd> navigate${quiz.mode === 'exam' ? ' · <kbd>F</kbd> flag' : ''} · <kbd>Enter</kbd> ${quiz.mode === 'exam' ? 'next' : 'check / next'}</p>`;
  const inp = document.getElementById('fb-input');
  if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

function qtypeBadge(qtype) {
  const map = { multi: 'multi-select', truefalse: 'true/false', fillblank: 'fill in' };
  return map[qtype] ? `<span class="badge qtype" style="margin-left:6px">${map[qtype]}</span>` : '';
}
function isAnswered(q) {
  const a = quiz.answers[q.id];
  return q.qtype === 'fillblank' ? (typeof a === 'string' && a.trim() !== '') : (Array.isArray(a) && a.length > 0);
}

function navigator() {
  return `<div class="qnav">${quiz.questions.map((q, i) => {
    const cls = [
      i === quiz.current ? 'current' : '',
      isAnswered(q) ? 'answered' : '',
      quiz.flagged[q.id] ? 'flagged' : ''
    ].join(' ');
    return `<button class="${cls}" onclick="jumpTo(${i})" title="Question ${i + 1}${quiz.flagged[q.id] ? ' (flagged)' : ''}">${i + 1}</button>`;
  }).join('')}</div>`;
}

function questionBody(q, chosen, revealed) {
  if (q.qtype === 'fillblank') {
    return `<input id="fb-input" placeholder="Type your answer…" value="${esc(typeof chosen === 'string' ? chosen : '')}"
      ${revealed ? 'disabled' : ''} oninput="fillblankInput(${q.id},this.value)" style="margin-top:8px">`;
  }
  const chosenArr = Array.isArray(chosen) ? chosen : [];
  return q.options.map((opt, i) => {
    let cls = '';
    if (revealed) {
      const isCorrect = q.correct.includes(i);
      if (isCorrect) cls = 'correct';
      else if (chosenArr.includes(i)) cls = 'wrong';
    } else if (chosenArr.includes(i)) cls = 'selected';
    return `<button class="option ${cls}" ${revealed ? 'disabled' : ''} onclick="chooseOption(${q.id},${i})">
      <span class="letter">${LETTERS[i]}</span><span>${esc(opt)}</span></button>`;
  }).join('');
}

function revealBox(q, chosen) {
  let good;
  if (q.qtype === 'fillblank') good = q.correct.some(a => normText(a) === normText(chosen));
  else good = JSON.stringify((chosen || []).slice().sort((a, b) => a - b)) === JSON.stringify(q.correct);
  const answerText = q.qtype === 'fillblank'
    ? `Accepted: <strong>${q.correct.map(esc).join(' / ')}</strong>`
    : `The answer is <strong>${q.correct.map(i => LETTERS[i]).join(' + ')}</strong>.`;
  return `
    <div class="explanation ${good ? 'good' : 'bad'}">
      <strong>${good ? '✓ Correct!' : `✗ Not quite — ${answerText}`}</strong>
      <p style="margin:8px 0 12px">${esc(q.explanation)}</p>
      ${sourceLink(q)}
      ${askWidget(q.id)}
    </div>`;
}
const normText = s => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.。]$/, '');

function chooseOption(questionId, index) {
  const q = quiz.questions.find(x => x.id === questionId);
  if (quiz.mode !== 'exam' && quiz.revealed[questionId]) return;
  if (q.qtype === 'multi') {
    const cur = Array.isArray(quiz.answers[questionId]) ? quiz.answers[questionId] : [];
    quiz.answers[questionId] = cur.includes(index) ? cur.filter(i => i !== index) : [...cur, index];
  } else {
    quiz.answers[questionId] = [index];
    if (quiz.mode !== 'exam') quiz.revealed[questionId] = true;
  }
  saveQuizState();
  renderQuestion();
}

function fillblankInput(questionId, value) {
  quiz.answers[questionId] = value;
  saveQuizState();
  const btn = document.getElementById('checkBtn');
  if (btn) btn.disabled = !value.trim();
}

function checkAnswer(questionId) {
  const q = quiz.questions.find(x => x.id === questionId);
  if (!canCheck(q)) return;
  quiz.revealed[questionId] = true;
  saveQuizState();
  renderQuestion();
}

function toggleFlag(questionId) {
  quiz.flagged[questionId] = !quiz.flagged[questionId];
  saveQuizState();
  renderQuestion();
}

function jumpTo(i) { quiz.current = i; saveQuizState(); renderQuestion(); }
function moveQuestion(delta) {
  quiz.current = Math.min(Math.max(quiz.current + delta, 0), quiz.questions.length - 1);
  saveQuizState();
  renderQuestion();
}

function confirmSubmit(answeredCount) {
  const open = quiz.questions.length - answeredCount;
  const flagged = Object.values(quiz.flagged).filter(Boolean).length;
  const warn = [
    open ? `${open} unanswered` : '',
    flagged ? `${flagged} still flagged` : ''
  ].filter(Boolean).join(', ');
  if (confirm(warn ? `Submit your exam? (${warn})` : 'Submit your exam?')) finishQuiz();
}

async function finishQuiz() {
  if (!quiz) return;
  if (quiz.timerInterval) { clearInterval(quiz.timerInterval); quiz.timerInterval = null; }
  document.removeEventListener('keydown', quizKeys);
  const answers = quiz.questions.filter(isAnswered)
    .map(q => ({ questionId: q.id, chosen: quiz.answers[q.id] }));
  let result;
  try {
    result = await api(`/api/topics/${quiz.topicId}/attempts`, {
      method: 'POST', body: { session_id: quiz.sessionId, answers }
    });
  } catch (e) { toast(e.message); return go('dashboard'); }
  clearQuizState(quiz.sessionId);
  renderResults(result);
}

// ---------- results ----------
function renderResults(result) {
  askThreads = {};
  const pct = result.total ? Math.round(result.score / result.total * 100) : 0;
  const emoji = pct >= 80 ? '🏆' : pct >= 60 ? '👍' : '💪';
  const wrong = result.detailed.filter(d => d.correct === false).length;
  const { topicId, mode } = quiz;
  $app.innerHTML = `
    <div class="card">
      <div class="score-hero">
        <div style="font-size:2.6rem">${emoji}</div>
        <div class="big" style="color:${pct >= 60 ? 'var(--green)' : 'var(--red)'}">${pct}%</div>
        <p style="color:var(--text-dim)">
          ${result.score} of ${result.total} correct · ${fmtTime(result.duration_seconds)}
          ${result.overtime ? ' · <span style="color:var(--amber)">⏱ overtime</span>' : ''}
          · ${mode === 'exam' ? 'mock exam' : mode === 'weak' ? 'weak-spot drill' : 'review session'}
        </p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          ${wrong ? `<button class="primary" onclick="go('quiz',{topicId:${topicId},mode:'weak'})">🎯 Drill my ${wrong} mistake${wrong > 1 ? 's' : ''}</button>` : ''}
          <button onclick="go('quiz',{topicId:${topicId},mode:'${mode}'})">Try again</button>
          <button onclick="go('topic',{topicId:${topicId}})">📊 Topic stats</button>
          <button onclick="go('dashboard')">Back to topics</button>
        </div>
      </div>
    </div>
    <h2 style="margin-top:30px">Answer review</h2>
    ${result.detailed.map((item, idx) => answerCard(item, idx)).join('')}`;
  window.scrollTo(0, 0);
  quiz = null;
}

// Shared by the results screen and the past-attempt view
function answerCard(item, idx) {
  if (item.missing) {
    return `<div class="card review-q"><em style="color:var(--text-dim)">Q${idx + 1}. This question was removed from the topic after the attempt.</em></div>`;
  }
  const skipped = item.correct === null || item.chosen === null;
  const good = item.correct === true;
  const fmtAns = v => item.qtype === 'fillblank'
    ? `“${esc(v)}”`
    : (Array.isArray(v) ? v : [v]).map(i => `${LETTERS[i]}. ${esc(item.options[i])}`).join('<br>&nbsp;&nbsp;&nbsp;&nbsp;');
  const correctText = item.qtype === 'fillblank'
    ? item.correct_answer.map(esc).join(' / ')
    : fmtAns(item.correct_answer);
  return `
  <div class="card review-q">
    <div class="q-head">
      <span style="font-size:1.2rem">${skipped ? '⊘' : good ? '✅' : '❌'}</span>
      <strong>Q${idx + 1}. ${esc(item.question)}</strong>
      ${qtypeBadge(item.qtype)}
    </div>
    <p style="margin:10px 0 4px">
      ${skipped ? '<em style="color:var(--text-dim)">Not answered.</em>'
        : `Your answer: <strong style="color:${good ? 'var(--green)' : 'var(--red)'}">${fmtAns(item.chosen)}</strong>`}
      ${!good ? `<br>Correct answer: <strong style="color:var(--green)">${correctText}</strong>` : ''}
    </p>
    <div class="explanation ${good ? 'good' : 'bad'}" style="margin-top:10px">
      ${esc(item.explanation)}
      <div style="margin-top:8px">${sourceLink(item)}</div>
      ${askWidget(item.questionId)}
    </div>
  </div>`;
}

// ---------- ask-the-AI follow-up widget ----------
function askWidget(questionId) {
  const thread = askThreads[questionId] || [];
  return `
  <div class="ask-box" id="ask-${questionId}">
    ${thread.map(t => `
      <div class="ask-q">🙋 ${esc(t.q)}</div>
      <div class="ask-a">🤖 ${esc(t.a)}</div>`).join('')}
    <div class="ask-row">
      <input placeholder="Ask a follow-up about this concept…" maxlength="500"
        onkeydown="if(event.key==='Enter'){event.preventDefault();sendAsk(${questionId},this)}">
      <button onclick="sendAsk(${questionId},this.previousElementSibling)">Ask</button>
    </div>
  </div>`;
}

async function sendAsk(questionId, inputEl) {
  const question = inputEl.value.trim();
  if (!question) return;
  const box = document.getElementById(`ask-${questionId}`);
  const row = box.querySelector('.ask-row');
  row.innerHTML = `<span class="spinner"></span> <span style="color:var(--text-dim)">Thinking…</span>`;
  try {
    const { answer } = await api(`/api/questions/${questionId}/ask`, {
      method: 'POST', body: { question, history: askThreads[questionId] || [] }
    });
    askThreads[questionId] = [...(askThreads[questionId] || []), { q: question, a: answer }];
  } catch (e) { toast(e.message); }
  box.outerHTML = askWidget(questionId);
}

// ---------- topic detail (history, trend, leaderboard) ----------
async function renderTopicDetail(topicId) {
  const t = await api(`/api/topics/${topicId}`);
  const attempts = await api(`/api/topics/${topicId}/attempts`);
  const leaderboard = t.is_shared ? await api(`/api/topics/${topicId}/leaderboard`).catch(() => []) : null;
  const exams = attempts.filter(a => a.mode === 'exam' && a.total > 0).slice().reverse();
  const ready = t.status !== 'generating' && t.question_count > 0;

  $app.innerHTML = `
    <div class="crumb"><a href="#" onclick="go('dashboard');return false">← All topics</a></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
      <div>
        <h1 style="margin:0 0 6px">${esc(t.title)}</h1>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span class="badge ${t.status}">${t.status === 'generating' ? '<span class="spinner"></span>' : ''}${t.status}</span>
          ${t.is_shared ? '<span class="badge shared">👥 shared</span>' : ''}
          ${readinessBadge(t.readiness)}
          <span style="color:var(--text-dim);font-size:.85rem">
            ${t.question_count} questions · ${esc(t.difficulty)} · ${t.timer_minutes} min timer
            ${!t.is_owner ? ` · by <strong>${esc(t.owner)}</strong>` : ''}
          </span>
        </div>
        ${t.status === 'generating' ? `<div class="meta" id="gen-msg-${t.id}" style="margin-top:6px">${esc(t.status_message || 'Working…')}</div>` : ''}
        ${t.status === 'error' ? `<div class="meta" style="color:var(--red);margin-top:6px">⚠ ${esc(t.status_message)}</div>` : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${ready ? `
          <button class="primary" onclick="go('quiz',{topicId:${t.id},mode:'exam'})">⏱ Mock exam</button>
          <button onclick="go('quiz',{topicId:${t.id},mode:'review'})">📖 Review</button>
          ${t.weak_count ? `<button onclick="go('quiz',{topicId:${t.id},mode:'weak'})">🎯 Weak spots (${t.weak_count})</button>` : ''}` : ''}
        ${t.is_owner ? `
          <button onclick="go('bank',{topicId:${t.id}})">🗂 Question bank</button>
          <button class="ghost" onclick="openTopicModal(${t.id})" title="Settings" aria-label="Topic settings">⚙️</button>` : ''}
      </div>
    </div>

    ${t.readiness ? `
    <div class="card" style="margin-top:20px">
      <strong>Readiness</strong>
      <p style="margin:6px 0 0;color:var(--text-dim)">Average of your last ${t.readiness.attempts} mock exam${t.readiness.attempts > 1 ? 's' : ''}:
        <strong style="color:${t.readiness.avg >= 80 ? 'var(--green)' : t.readiness.avg >= 60 ? 'var(--amber)' : 'var(--red)'}">${t.readiness.avg}%</strong>
        ${t.readiness.avg >= 80 ? " — you're consistently passing. Good luck on the real thing! 🎓" : t.readiness.avg >= 60 ? ' — almost there, drill your weak spots.' : ' — keep practicing, focus on review mode first.'}
      </p>
    </div>` : ''}

    ${exams.length >= 2 ? `<div class="card" style="margin-top:16px"><strong>Mock exam trend</strong>${trendChart(exams)}</div>` : ''}

    <h2 style="margin-top:30px">Attempt history</h2>
    ${attempts.length === 0
      ? `<div class="empty">No attempts yet — take a mock exam or review session to start tracking progress.</div>`
      : `<div class="card" style="overflow-x:auto"><table>
          <thead><tr><th>When</th><th>Mode</th><th>Score</th><th>Time</th><th></th></tr></thead><tbody>
          ${attempts.map(a => `<tr>
            <td style="color:var(--text-dim);white-space:nowrap">${esc(a.finished_at.slice(0, 16).replace('T', ' '))}</td>
            <td>${a.mode === 'exam' ? '⏱ exam' : a.mode === 'weak' ? '🎯 weak' : '📖 review'}</td>
            <td><strong style="color:${a.total && a.score / a.total >= .6 ? 'var(--green)' : 'var(--red)'}">${a.score}/${a.total}</strong>
              ${a.total ? `(${Math.round(a.score * 100 / a.total)}%)` : ''}</td>
            <td>${fmtTime(a.duration_seconds || 0)}${a.overtime ? ' <span title="Finished past the time limit" style="color:var(--amber)">⏱+</span>' : ''}</td>
            <td><button class="ghost" onclick="go('attempt',{attemptId:${a.id}})">View →</button></td>
          </tr>`).join('')}
          </tbody></table></div>`}

    ${leaderboard && leaderboard.length ? `
      <h2 style="margin-top:30px">Leaderboard 🏆</h2>
      <div class="card" style="overflow-x:auto"><table>
        <thead><tr><th>#</th><th>User</th><th>Best exam score</th><th>Exam attempts</th></tr></thead><tbody>
        ${leaderboard.map((r, i) => `<tr ${r.username === me.username ? 'style="font-weight:700"' : ''}>
          <td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${esc(r.username)}${r.username === me.username ? ' (you)' : ''}</td>
          <td>${r.best_pct}%</td><td>${r.attempts}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
  if (t.status === 'generating') pollTopic(t.id, () => renderTopicDetail(topicId));
}

// Tiny dependency-free SVG line chart of exam scores over time
function trendChart(exams) {
  const W = 640, H = 170, padL = 34, padR = 14, padT = 16, padB = 24;
  const n = exams.length;
  const x = i => padL + (n === 1 ? 0 : i * (W - padL - padR) / (n - 1));
  const y = pct => padT + (100 - pct) * (H - padT - padB) / 100;
  const pts = exams.map((a, i) => [x(i), y(a.score * 100 / a.total), Math.round(a.score * 100 / a.total)]);
  return `
  <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:8px" preserveAspectRatio="xMidYMid meet">
    ${[0, 50, 80, 100].map(g => `
      <line x1="${padL}" y1="${y(g)}" x2="${W - padR}" y2="${y(g)}" stroke="var(--border)" stroke-width="1" ${g === 80 ? 'stroke-dasharray="4 4"' : ''}/>
      <text x="${padL - 6}" y="${y(g) + 4}" text-anchor="end" font-size="10" fill="var(--text-dim)">${g}</text>`).join('')}
    <polyline points="${pts.map(p => `${p[0]},${p[1]}`).join(' ')}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round"/>
    ${pts.map(p => `
      <circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(--primary)"/>
      <text x="${p[0]}" y="${p[1] - 9}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${p[2]}%</text>`).join('')}
  </svg>`;
}

// ---------- past attempt detail ----------
async function renderAttemptDetail(attemptId) {
  askThreads = {};
  const { attempt, topic, items } = await api(`/api/attempts/${attemptId}`);
  const pct = attempt.total ? Math.round(attempt.score / attempt.total * 100) : 0;
  $app.innerHTML = `
    <div class="crumb"><a href="#" onclick="go('topic',{topicId:${topic.id}});return false">← ${esc(topic.title)}</a></div>
    <h1 style="margin:0 0 4px">Attempt review</h1>
    <p style="color:var(--text-dim)">
      ${attempt.mode === 'exam' ? '⏱ Mock exam' : attempt.mode === 'weak' ? '🎯 Weak-spot drill' : '📖 Review session'} ·
      ${esc(attempt.finished_at.slice(0, 16).replace('T', ' '))} ·
      <strong style="color:${pct >= 60 ? 'var(--green)' : 'var(--red)'}">${attempt.score}/${attempt.total} (${pct}%)</strong> ·
      ${fmtTime(attempt.duration_seconds || 0)}${attempt.overtime ? ' · <span style="color:var(--amber)">⏱ overtime</span>' : ''}
    </p>
    ${items.map((item, idx) => answerCard(item, idx)).join('')}`;
  window.scrollTo(0, 0);
}

// ---------- question bank ----------
async function renderBank(topicId) {
  const t = await api(`/api/topics/${topicId}`);
  const bank = await api(`/api/topics/${topicId}/bank`);
  bankCache = {};
  bank.forEach(q => bankCache[q.id] = q);
  const generating = t.status === 'generating';

  $app.innerHTML = `
    <div class="crumb"><a href="#" onclick="go('topic',{topicId:${topicId}});return false">← ${esc(t.title)}</a></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h1 style="margin:0">Question bank <span style="color:var(--text-dim);font-weight:400;font-size:1.1rem">(${bank.length})</span></h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button onclick="openQuestionEditor(${topicId})">＋ Add manually</button>
        ${!generating ? `
          <span style="display:inline-flex;gap:6px;align-items:center">
            <input id="add-n" type="number" min="1" max="50" value="10" style="width:70px;padding:8px">
            <button class="primary" onclick="bankGenerate(${topicId}, true)">✨ Add AI questions</button>
          </span>
          ${bank.length ? `<button class="danger" onclick="bankGenerate(${topicId}, false)">♻ Replace all</button>` : ''}`
        : `<span><span class="spinner"></span> <span id="gen-msg-${topicId}" style="color:var(--text-dim)">${esc(t.status_message || 'Generating…')}</span></span>`}
      </div>
    </div>
    ${bank.length === 0 && !generating ? `<div class="empty">No questions yet — generate some or add them manually.</div>` : ''}
    ${bank.map((q, i) => `
      <div class="card bank-q">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div style="min-width:0">
            <strong>${i + 1}. ${esc(q.question)}</strong>
            <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              <span class="badge ${q.difficulty}">${q.difficulty}</span>${qtypeBadge(q.qtype)}
              <span style="font-size:.82rem;color:var(--text-dim)">✔ ${q.qtype === 'fillblank'
                ? esc(q.correct.join(' / '))
                : q.correct.map(c => `${LETTERS[c]}. ${esc(String(q.options[c]).slice(0, 60))}`).join(' · ')}</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="ghost" onclick="openQuestionEditor(${topicId}, ${q.id})" title="Edit question" aria-label="Edit question">✏️</button>
            <button class="ghost" style="color:var(--red)" onclick="deleteQuestion(${topicId}, ${q.id})" title="Delete question" aria-label="Delete question">🗑</button>
          </div>
        </div>
      </div>`).join('')}`;
  if (generating) pollTopic(topicId, () => renderBank(topicId));
}

async function bankGenerate(topicId, append) {
  if (!append && !confirm('Replace ALL questions with a freshly generated set?\n\nThis clears your per-question weak-spot stats for this topic, and old attempt reviews will no longer show question details.')) return;
  const count = parseInt(document.getElementById('add-n')?.value) || 10;
  if (await generateQuestions(topicId, append ? { append: true, count } : {})) renderBank(topicId);
}

async function deleteQuestion(topicId, qid) {
  if (!confirm('Delete this question?')) return;
  try { await api(`/api/questions/${qid}`, { method: 'DELETE' }); renderBank(topicId); }
  catch (e) { toast(e.message); }
}

function openQuestionEditor(topicId, qid) {
  const q = qid ? bankCache[qid] : { qtype: 'single', question: '', options: ['', '', '', ''], correct: [0], difficulty: 'medium', explanation: '', source_url: '', source_title: '' };
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const optionsSection = (qtype, options, correct) => {
    if (qtype === 'fillblank') return `
      <label>Acceptable answers (one per line)</label>
      <textarea id="q-answers" rows="3" placeholder="TCP&#10;Transmission Control Protocol">${esc((correct || []).join('\n'))}</textarea>
      <p style="font-size:.8rem;color:var(--text-dim)">Tip: put a blank like ____ in the question text.</p>`;
    if (qtype === 'truefalse') return `
      <label>Correct answer</label>
      <select id="q-tf"><option value="0" ${correct[0] === 0 ? 'selected' : ''}>True</option><option value="1" ${correct[0] === 1 ? 'selected' : ''}>False</option></select>`;
    const n = qtype === 'multi' ? 5 : 4;
    const opts = Array.from({ length: n }, (_, i) => options[i] || '');
    return `
      <label>Options — mark the correct one${qtype === 'multi' ? 's (exactly 2)' : ''}</label>
      ${opts.map((o, i) => `
        <div style="display:flex;gap:8px;align-items:center;margin:6px 0">
          <input type="${qtype === 'multi' ? 'checkbox' : 'radio'}" name="q-correct" value="${i}" ${correct.includes(i) ? 'checked' : ''} style="width:auto">
          <input class="q-opt" data-i="${i}" value="${esc(o)}" placeholder="Option ${LETTERS[i]}">
        </div>`).join('')}`;
  };

  const render = qtype => {
    backdrop.innerHTML = `
    <div class="card modal" style="max-width:560px">
      <h2 style="margin-top:0">${qid ? 'Edit question' : 'Add question'}</h2>
      <label>Type</label>
      <select id="q-type">
        ${[['single', 'Multiple choice'], ['multi', 'Multi-select (choose 2)'], ['truefalse', 'True / false'], ['fillblank', 'Fill in the blank']]
          .map(([v, l]) => `<option value="${v}" ${qtype === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <label>Question</label>
      <textarea id="q-text" rows="2">${esc(q.question)}</textarea>
      <div id="q-options">${optionsSection(qtype, q.options, q.correct)}</div>
      <label>Difficulty</label>
      <select id="q-diff">${['easy', 'medium', 'hard'].map(d => `<option ${q.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <label>Explanation</label>
      <textarea id="q-expl" rows="3" placeholder="Why is the correct answer right, and the others wrong?">${esc(q.explanation)}</textarea>
      <label>Source URL (optional)</label>
      <input id="q-url" value="${esc(q.source_url)}" placeholder="https://en.wikipedia.org/wiki/…">
      <label>Source title (optional)</label>
      <input id="q-urltitle" value="${esc(q.source_title)}">
      <div style="display:flex;gap:10px;margin-top:22px;justify-content:flex-end">
        <button id="q-cancel">Cancel</button>
        <button class="primary" id="q-save">${qid ? 'Save' : 'Add'}</button>
      </div>
    </div>`;
    backdrop.querySelector('#q-type').onchange = e => render(e.target.value);
    backdrop.querySelector('#q-cancel').onclick = () => backdrop.remove();
    backdrop.querySelector('#q-save').onclick = async () => {
      const type = backdrop.querySelector('#q-type').value;
      const body = {
        qtype: type,
        question: backdrop.querySelector('#q-text').value.trim(),
        difficulty: backdrop.querySelector('#q-diff').value,
        explanation: backdrop.querySelector('#q-expl').value.trim(),
        source_url: backdrop.querySelector('#q-url').value.trim(),
        source_title: backdrop.querySelector('#q-urltitle').value.trim(),
        learn_more_query: q.learn_more_query || ''
      };
      if (type === 'fillblank') {
        body.options = [];
        body.correct = backdrop.querySelector('#q-answers').value.split('\n').map(s => s.trim()).filter(Boolean);
      } else if (type === 'truefalse') {
        body.options = ['True', 'False'];
        body.correct = [parseInt(backdrop.querySelector('#q-tf').value)];
      } else {
        body.options = [...backdrop.querySelectorAll('.q-opt')].map(i => i.value.trim());
        body.correct = [...backdrop.querySelectorAll('[name=q-correct]:checked')].map(i => parseInt(i.value));
        if (body.options.some(o => !o)) return toast('Fill in all options');
      }
      if (!body.question) return toast('Question text required');
      try {
        if (qid) await api(`/api/questions/${qid}`, { method: 'PUT', body });
        else await api(`/api/topics/${topicId}/bank`, { method: 'POST', body });
        backdrop.remove(); toast(qid ? 'Question updated' : 'Question added'); renderBank(topicId);
      } catch (e) { toast(e.message); }
    };
  };
  render(q.qtype);
  document.body.appendChild(backdrop);
  backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
}

// ---------- admin ----------
async function renderAdmin(tab = 'users') {
  const [users, topics, settings] = await Promise.all([
    api('/api/admin/users'), api('/api/admin/topics'), api('/api/admin/settings')
  ]);
  $app.innerHTML = `
    <h1>Admin</h1>
    <div class="tabs">
      <button class="${tab === 'users' ? 'active' : ''}" onclick="renderAdmin('users')">Users</button>
      <button class="${tab === 'topics' ? 'active' : ''}" onclick="renderAdmin('topics')">Exam topics</button>
      <button class="${tab === 'settings' ? 'active' : ''}" onclick="renderAdmin('settings')">Settings</button>
    </div>
    <div class="card" style="overflow-x:auto">
    ${tab === 'users' ? `
      <table><thead><tr><th>User</th><th>Role</th><th>Topics</th><th>Attempts</th><th>Joined</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr>
        <td><strong>${esc(u.username)}</strong>${u.id === me.id ? ' <span style="color:var(--text-dim)">(you)</span>' : ''}</td>
        <td>${u.is_admin ? '<span class="badge ready">admin</span>' : 'user'}</td>
        <td>${u.topic_count}</td><td>${u.attempt_count}</td>
        <td style="color:var(--text-dim)">${u.created_at.slice(0, 10)}</td>
        <td style="white-space:nowrap">
          <button onclick="adminToggleAdmin(${u.id},${u.is_admin ? 0 : 1})" ${u.id === me.id ? 'disabled' : ''}>${u.is_admin ? 'Revoke admin' : 'Make admin'}</button>
          <button onclick="adminResetPassword(${u.id},'${esc(u.username)}')">Reset pw</button>
          <button class="danger" onclick="adminDeleteUser(${u.id},'${esc(u.username)}')" ${u.id === me.id ? 'disabled' : ''}>Delete</button>
        </td></tr>`).join('')}
      </tbody></table>` : ''}
    ${tab === 'topics' ? `
      <table><thead><tr><th>Topic</th><th>Owner</th><th>Status</th><th>Shared</th><th>Questions</th><th>Difficulty</th><th></th></tr></thead><tbody>
      ${topics.map(t => `<tr>
        <td><strong>${esc(t.title)}</strong></td><td>${esc(t.username)}</td>
        <td><span class="badge ${t.status}">${t.status}</span></td>
        <td>${t.is_shared ? '👥' : '—'}</td>
        <td>${t.question_count}/${t.num_questions}</td><td>${esc(t.difficulty)}</td>
        <td><button class="danger" onclick="adminDeleteTopic(${t.id},'${esc(t.title)}')">Delete</button></td></tr>`).join('')}
      ${topics.length === 0 ? '<tr><td colspan="7" style="color:var(--text-dim)">No topics yet</td></tr>' : ''}
      </tbody></table>` : ''}
    ${tab === 'settings' ? `
      <h3 style="margin-top:0">Anthropic API key</h3>
      <p style="color:var(--text-dim);font-size:.92rem">Used to research topics and generate questions, explanations and source links.
      Get a key at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
      <p>Status: ${settings.api_key_set
        ? `<span class="badge ready">configured</span> <code>${esc(settings.api_key_hint)}</code>`
        : `<span class="badge error">not set</span> — question generation won't work yet`}</p>
      <label>API key</label>
      <input id="apiKey" type="password" placeholder="sk-ant-…">
      <button class="primary" style="margin-top:14px" onclick="adminSaveKey()">Save key</button>` : ''}
    </div>`;
}

async function adminToggleAdmin(id, makeAdmin) {
  try { await api(`/api/admin/users/${id}`, { method: 'PUT', body: { is_admin: makeAdmin } }); renderAdmin('users'); }
  catch (e) { toast(e.message); }
}
async function adminResetPassword(id, name) {
  const pw = prompt(`New password for ${name} (min 6 chars):`);
  if (!pw) return;
  try { await api(`/api/admin/users/${id}`, { method: 'PUT', body: { password: pw } }); toast('Password updated'); }
  catch (e) { toast(e.message); }
}
async function adminDeleteUser(id, name) {
  if (!confirm(`Delete user "${name}" and all their topics and results?`)) return;
  try { await api(`/api/admin/users/${id}`, { method: 'DELETE' }); renderAdmin('users'); }
  catch (e) { toast(e.message); }
}
async function adminDeleteTopic(id, title) {
  if (!confirm(`Delete topic "${title}"?`)) return;
  try { await api(`/api/admin/topics/${id}`, { method: 'DELETE' }); renderAdmin('topics'); }
  catch (e) { toast(e.message); }
}
async function adminSaveKey() {
  try {
    await api('/api/admin/settings', { method: 'PUT', body: { anthropic_api_key: document.getElementById('apiKey').value } });
    toast('API key saved'); renderAdmin('settings');
  } catch (e) { toast(e.message); }
}

// ---------- boot ----------
(async () => {
  me = await api('/api/me');
  if (me) onLoggedIn(); else showLanding();
})();
