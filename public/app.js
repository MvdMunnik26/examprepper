// ExamPrepper frontend — a small single-page app, no frameworks
let me = null;            // current user
let quiz = null;          // active quiz state
let pollTimers = {};      // topic generation polling

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  document.getElementById('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
}
document.getElementById('themeBtn').onclick = () =>
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
applyTheme(localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- tiny markdown renderer (headings, bold, italics, lists, code, paragraphs) ----------
function md(text) {
  const lines = esc(text).split('\n');
  let html = '', inList = false;
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  for (const line of lines) {
    const l = line.trim();
    const list = /^[-*] (.*)/.exec(l) || /^\d+\. (.*)/.exec(l);
    if (list) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(list[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    const h = /^(#{1,4}) (.*)/.exec(l);
    if (h) { html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; continue; }
    if (l) html += `<p>${inline(l)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

// ---------- router ----------
async function go(view, arg) {
  Object.values(pollTimers).forEach(clearInterval); pollTimers = {};
  if (quiz?.timerInterval) clearInterval(quiz.timerInterval);
  if (view === 'dashboard') return renderDashboard();
  if (view === 'admin') return renderAdmin();
  if (view === 'quiz') return startQuiz(arg.topicId, arg.mode);
  if (view === 'deepdive') return renderDeepDive(arg);
}

// ---------- auth ----------
function renderAuth(mode = 'login') {
  document.getElementById('header').style.display = 'none';
  $app.innerHTML = `
    <div class="auth-wrap">
      <h1>🎓 Exam<span style="color:var(--primary)">Prepper</span></h1>
      <div class="card">
        <h2 style="margin-top:0">${mode === 'login' ? 'Log in' : 'Create account'}</h2>
        <label>Username</label><input id="username" autocomplete="username">
        <label>Password</label><input id="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
        <button class="primary" id="authGo" style="width:100%;margin-top:20px;padding:12px">${mode === 'login' ? 'Log in' : 'Register'}</button>
        <div class="auth-toggle">${mode === 'login'
          ? `No account yet? <a href="#" id="authSwitch">Register</a>`
          : `Already registered? <a href="#" id="authSwitch">Log in</a>`}</div>
      </div>
    </div>`;
  document.getElementById('authSwitch').onclick = e => { e.preventDefault(); renderAuth(mode === 'login' ? 'register' : 'login'); };
  const submit = async () => {
    try {
      me = await api(mode === 'login' ? '/api/login' : '/api/register', {
        method: 'POST',
        body: { username: document.getElementById('username').value, password: document.getElementById('password').value }
      });
      onLoggedIn();
    } catch (e) { toast(e.message); }
  };
  document.getElementById('authGo').onclick = submit;
  $app.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
}

function onLoggedIn() {
  document.getElementById('header').style.display = 'flex';
  document.getElementById('whoami').textContent = me.username;
  document.getElementById('adminBtn').style.display = me.is_admin ? '' : 'none';
  go('dashboard');
}

async function logout() { await api('/api/logout', { method: 'POST' }); me = null; renderAuth(); }

// ---------- dashboard ----------
async function renderDashboard() {
  const topics = await api('/api/topics');
  $app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <h1 style="margin:0">My exam topics</h1>
      <button class="primary" onclick="openTopicModal()">+ New topic</button>
    </div>
    ${topics.length === 0
      ? `<div class="empty"><p style="font-size:2.4rem;margin:0">📚</p><p>No topics yet. Add your first exam topic and I'll research it and build a question set for you.</p></div>`
      : `<div class="topic-grid">${topics.map(topicCard).join('')}</div>`}`;
  topics.filter(t => t.status === 'generating').forEach(t => pollTopic(t.id));
}

function topicCard(t) {
  const ready = t.status === 'ready' && t.question_count > 0;
  return `
  <div class="card topic-card" id="topic-${t.id}">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
      <h3>${esc(t.title)}</h3>
      <span class="badge ${t.status}">${t.status === 'generating' ? '<span class="spinner"></span>' : ''}${t.status}</span>
    </div>
    <div class="meta">
      ${t.question_count || 0} questions · ${esc(t.difficulty)} · ${t.timer_minutes} min timer
      ${t.best_score != null ? ` · best: ${Math.round(t.best_score)}%` : ''}
    </div>
    ${t.status === 'error' ? `<div class="meta" style="color:var(--red)">⚠ ${esc(t.status_message)}</div>` : ''}
    <div class="btn-row">
      ${ready ? `
        <button class="primary" onclick="go('quiz',{topicId:${t.id},mode:'exam'})">⏱ Mock exam</button>
        <button onclick="go('quiz',{topicId:${t.id},mode:'review'})">📖 Review</button>` : ''}
      ${t.status !== 'generating' ? `
        <button onclick="generateQuestions(${t.id})">${t.question_count > 0 ? '🔄 Regenerate' : '✨ Generate questions'}</button>` : ''}
      <button class="ghost" onclick="openTopicModal(${t.id})" title="Settings">⚙️</button>
    </div>
  </div>`;
}

async function generateQuestions(topicId) {
  try {
    await api(`/api/topics/${topicId}/generate`, { method: 'POST' });
    toast('Researching topic and generating questions…');
    renderDashboard();
  } catch (e) { toast(e.message); }
}

function pollTopic(topicId) {
  pollTimers[topicId] = setInterval(async () => {
    try {
      const s = await api(`/api/topics/${topicId}/status`);
      if (s.status !== 'generating') {
        clearInterval(pollTimers[topicId]); delete pollTimers[topicId];
        toast(s.status === 'ready' ? 'Questions ready! 🎉' : `Generation failed: ${s.status_message}`);
        renderDashboard();
      }
    } catch { clearInterval(pollTimers[topicId]); }
  }, 3000);
}

// ---------- topic create/settings modal ----------
async function openTopicModal(topicId) {
  let t = { title: '', description: '', num_questions: 20, difficulty: 'mixed', timer_minutes: 20 };
  if (topicId) {
    const topics = await api('/api/topics');
    t = topics.find(x => x.id === topicId) || t;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="card modal">
      <h2 style="margin-top:0">${topicId ? 'Topic settings' : 'New exam topic'}</h2>
      <label>Topic title</label>
      <input id="m-title" value="${esc(t.title)}" placeholder="e.g. AWS Solutions Architect, Dutch history, TCP/IP networking">
      <label>Extra context (optional)</label>
      <textarea id="m-desc" rows="2" placeholder="Focus areas, exam level, what to emphasise…">${esc(t.description)}</textarea>
      <label>Number of questions (5–50)</label>
      <input id="m-num" type="number" min="5" max="50" value="${t.num_questions}">
      <label>Difficulty</label>
      <select id="m-diff">
        ${['mixed', 'easy', 'medium', 'hard'].map(d => `<option value="${d}" ${t.difficulty === d ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}
      </select>
      <label>Mock exam timer (minutes)</label>
      <input id="m-timer" type="number" min="5" max="180" value="${t.timer_minutes}">
      <div style="display:flex;gap:10px;margin-top:22px;justify-content:flex-end;flex-wrap:wrap">
        ${topicId ? `<button class="danger" id="m-delete">Delete topic</button>` : ''}
        <button id="m-cancel">Cancel</button>
        <button class="primary" id="m-save">${topicId ? 'Save settings' : 'Create topic'}</button>
      </div>
      ${topicId ? `<p style="font-size:.82rem;color:var(--text-dim)">Changes to question count or difficulty apply the next time you generate questions.</p>` : ''}
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
  backdrop.querySelector('#m-cancel').onclick = () => backdrop.remove();
  if (topicId) backdrop.querySelector('#m-delete').onclick = async () => {
    if (!confirm('Delete this topic and all its questions and results?')) return;
    await api(`/api/topics/${topicId}`, { method: 'DELETE' });
    backdrop.remove(); toast('Topic deleted'); renderDashboard();
  };
  backdrop.querySelector('#m-save').onclick = async () => {
    const body = {
      title: backdrop.querySelector('#m-title').value,
      description: backdrop.querySelector('#m-desc').value,
      num_questions: backdrop.querySelector('#m-num').value,
      difficulty: backdrop.querySelector('#m-diff').value,
      timer_minutes: backdrop.querySelector('#m-timer').value
    };
    try {
      if (topicId) { await api(`/api/topics/${topicId}/settings`, { method: 'PUT', body }); toast('Settings saved'); }
      else {
        const created = await api('/api/topics', { method: 'POST', body });
        toast('Topic created — generating questions…');
        api(`/api/topics/${created.id}/generate`, { method: 'POST' }).catch(e => toast(e.message));
      }
      backdrop.remove(); renderDashboard();
    } catch (e) { toast(e.message); }
  };
}

// ---------- quiz ----------
async function startQuiz(topicId, mode) {
  const data = await api(`/api/topics/${topicId}/questions`);
  if (!data.questions.length) { toast('No questions yet — generate them first.'); return go('dashboard'); }
  quiz = {
    topicId, mode, topic: data.topic, questions: data.questions,
    current: 0, answers: {}, revealed: {}, startedAt: Date.now(),
    secondsLeft: data.topic.timer_minutes * 60, timerInterval: null
  };
  if (mode === 'exam') {
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
}

const fmtTime = s => `${Math.floor(Math.max(s, 0) / 60)}:${String(Math.max(s, 0) % 60).padStart(2, '0')}`;

function renderQuestion() {
  const q = quiz.questions[quiz.current];
  const chosen = quiz.answers[q.id];
  const revealed = quiz.mode === 'review' && quiz.revealed[q.id];
  const answeredCount = Object.keys(quiz.answers).length;
  const last = quiz.current === quiz.questions.length - 1;

  $app.innerHTML = `
    <div class="quiz-top">
      <div>
        <div class="crumb">${esc(quiz.topic.title)} · ${quiz.mode === 'exam' ? 'Mock exam' : 'Review mode'}</div>
        <strong>Question ${quiz.current + 1} of ${quiz.questions.length}</strong>
        <span class="badge ${q.difficulty}" style="margin-left:8px">${q.difficulty}</span>
      </div>
      ${quiz.mode === 'exam'
        ? `<div class="timer ${quiz.secondsLeft <= 60 ? 'low' : ''}" id="timer">${fmtTime(quiz.secondsLeft)}</div>`
        : `<button class="ghost" onclick="if(confirm('Leave review mode?'))go('dashboard')">✕ Exit</button>`}
    </div>
    <div class="progress-bar"><div style="width:${(quiz.current + 1) / quiz.questions.length * 100}%"></div></div>
    <div class="card">
      <h2 style="margin-top:0;font-size:1.15rem">${esc(q.question)}</h2>
      ${q.options.map((opt, i) => {
        let cls = '';
        if (revealed) {
          if (i === q.correct_index) cls = 'correct';
          else if (i === chosen) cls = 'wrong';
        } else if (i === chosen) cls = 'selected';
        return `<button class="option ${cls}" ${revealed ? 'disabled' : ''} onclick="chooseOption(${q.id},${i})">
          <span class="letter">${'ABCD'[i]}</span><span>${esc(opt)}</span></button>`;
      }).join('')}
      ${revealed ? `
        <div class="explanation ${chosen === q.correct_index ? 'good' : 'bad'}">
          <strong>${chosen === q.correct_index ? '✓ Correct!' : `✗ Not quite — the answer is ${'ABCD'[q.correct_index]}.`}</strong>
          <p style="margin:8px 0 12px">${esc(q.explanation)}</p>
          <a href="#" onclick="event.preventDefault();go('deepdive',${q.id})">📚 Explore this topic in depth →</a>
        </div>` : ''}
    </div>
    <div class="quiz-nav">
      <button onclick="moveQuestion(-1)" ${quiz.current === 0 ? 'disabled' : ''}>← Previous</button>
      <div style="display:flex;gap:10px">
        ${quiz.mode === 'exam' ? `
          <span style="align-self:center;color:var(--text-dim);font-size:.88rem">${answeredCount}/${quiz.questions.length} answered</span>
          ${last || answeredCount === quiz.questions.length
            ? `<button class="primary" onclick="if(confirm('Submit your exam?'))finishQuiz()">Submit exam</button>` : ''}` : ''}
        ${!last ? `<button class="${quiz.mode === 'review' && revealed ? 'primary' : ''}" onclick="moveQuestion(1)">Next →</button>` : ''}
        ${last && quiz.mode === 'review' ? `<button class="primary" onclick="finishQuiz()">Finish review</button>` : ''}
      </div>
    </div>`;
}

function chooseOption(questionId, index) {
  if (quiz.mode === 'review' && quiz.revealed[questionId]) return;
  quiz.answers[questionId] = index;
  if (quiz.mode === 'review') quiz.revealed[questionId] = true;
  renderQuestion();
}

function moveQuestion(delta) {
  quiz.current = Math.min(Math.max(quiz.current + delta, 0), quiz.questions.length - 1);
  renderQuestion();
}

async function finishQuiz() {
  if (quiz.timerInterval) clearInterval(quiz.timerInterval);
  const answers = Object.entries(quiz.answers).map(([questionId, chosenIndex]) => ({ questionId: +questionId, chosenIndex }));
  const duration = Math.round((Date.now() - quiz.startedAt) / 1000);
  let result = { score: 0, total: answers.length };
  try {
    result = await api(`/api/topics/${quiz.topicId}/attempts`, {
      method: 'POST', body: { mode: quiz.mode, answers, duration_seconds: duration }
    });
  } catch (e) { toast(e.message); }
  renderResults(result, duration);
}

function renderResults(result, duration) {
  const pct = result.total ? Math.round(result.score / result.total * 100) : 0;
  const emoji = pct >= 80 ? '🏆' : pct >= 60 ? '👍' : '💪';
  $app.innerHTML = `
    <div class="card">
      <div class="score-hero">
        <div style="font-size:2.6rem">${emoji}</div>
        <div class="big" style="color:${pct >= 60 ? 'var(--green)' : 'var(--red)'}">${pct}%</div>
        <p style="color:var(--text-dim)">${result.score} of ${result.total} correct · ${fmtTime(duration)} ${quiz.mode === 'exam' ? '· mock exam' : '· review session'}</p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="primary" onclick="go('quiz',{topicId:${quiz.topicId},mode:'${quiz.mode}'})">Try again</button>
          <button onclick="go('dashboard')">Back to topics</button>
        </div>
      </div>
    </div>
    <h2 style="margin-top:30px">Answer review</h2>
    ${quiz.questions.map((q, idx) => {
      const chosen = quiz.answers[q.id];
      const correct = chosen === q.correct_index;
      const skipped = chosen === undefined;
      return `
      <div class="card review-q">
        <div class="q-head">
          <span style="font-size:1.2rem">${skipped ? '⊘' : correct ? '✅' : '❌'}</span>
          <strong>Q${idx + 1}. ${esc(q.question)}</strong>
        </div>
        <p style="margin:10px 0 4px">
          ${skipped ? '<em style="color:var(--text-dim)">Not answered.</em>'
            : `Your answer: <strong style="color:${correct ? 'var(--green)' : 'var(--red)'}">${'ABCD'[chosen]}. ${esc(q.options[chosen])}</strong>`}
          ${!correct ? `<br>Correct answer: <strong style="color:var(--green)">${'ABCD'[q.correct_index]}. ${esc(q.options[q.correct_index])}</strong>` : ''}
        </p>
        <div class="explanation ${correct ? 'good' : 'bad'}" style="margin-top:10px">
          ${esc(q.explanation)}
          <div style="margin-top:8px"><a href="#" onclick="event.preventDefault();go('deepdive',${q.id})">📚 Explore this topic in depth →</a></div>
        </div>
      </div>`;
    }).join('')}`;
  window.scrollTo(0, 0);
}

// ---------- deep dive ----------
async function renderDeepDive(questionId) {
  $app.innerHTML = `<div class="empty"><span class="spinner"></span> Writing your deep-dive article…</div>`;
  try {
    const d = await api(`/api/questions/${questionId}/deepdive`);
    $app.innerHTML = `
      <div class="crumb"><a href="#" onclick="event.preventDefault();go('dashboard')">← Back</a> · ${esc(d.topic)}</div>
      <div class="card article">
        <p style="color:var(--text-dim);font-size:.9rem;margin-top:0">Deep dive for: <em>${esc(d.question)}</em></p>
        ${md(d.deep_dive)}
        <hr style="border:none;border-top:1px solid var(--border);margin:24px 0">
        <p>🔎 Keep exploring on the web:
          <a href="https://www.google.com/search?q=${encodeURIComponent(d.learn_more_query)}" target="_blank" rel="noopener">${esc(d.learn_more_query)}</a></p>
      </div>`;
    window.scrollTo(0, 0);
  } catch (e) {
    $app.innerHTML = `<div class="empty">⚠ ${esc(e.message)}<br><br><button onclick="go('dashboard')">Back to topics</button></div>`;
  }
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
      <table><thead><tr><th>Topic</th><th>Owner</th><th>Status</th><th>Questions</th><th>Difficulty</th><th></th></tr></thead><tbody>
      ${topics.map(t => `<tr>
        <td><strong>${esc(t.title)}</strong></td><td>${esc(t.username)}</td>
        <td><span class="badge ${t.status}">${t.status}</span></td>
        <td>${t.question_count}/${t.num_questions}</td><td>${esc(t.difficulty)}</td>
        <td><button class="danger" onclick="adminDeleteTopic(${t.id},'${esc(t.title)}')">Delete</button></td></tr>`).join('')}
      ${topics.length === 0 ? '<tr><td colspan="6" style="color:var(--text-dim)">No topics yet</td></tr>' : ''}
      </tbody></table>` : ''}
    ${tab === 'settings' ? `
      <h3 style="margin-top:0">Anthropic API key</h3>
      <p style="color:var(--text-dim);font-size:.92rem">Used to research topics and generate questions, explanations and deep-dive articles.
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
  if (me) onLoggedIn(); else renderAuth();
})();
