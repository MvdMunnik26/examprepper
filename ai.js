// ai.js — talks to the Claude API to research topics, generate questions and answer follow-ups
const { getSetting } = require('./db');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6'; // good quality/cost balance for question generation
const BATCH_SIZE = 20;             // questions per API call — keeps responses well under the token limit
const MATERIAL_CHAR_LIMIT = 60000; // ~15k tokens of user-pasted study material

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || getSetting('anthropic_api_key');
}

async function callClaude(messages, maxTokens = 8000) {
  const apiKey = getApiKey();
  if (!apiKey) {
    const err = new Error('No Anthropic API key configured. An admin can add one under Admin → Settings.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content.map(b => b.text || '').join('');
}

// Pull a JSON array/object out of a model response that may contain extra prose
function extractJson(text) {
  const start = Math.min(
    ...['[', '{'].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; })
  );
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start === Infinity || end === -1) throw new Error('No JSON found in AI response');
  return JSON.parse(text.slice(start, end + 1));
}

// Validate and normalize one raw question object from the model (or from the manual editor).
// Returns null if it's not salvageable.
function normalizeQuestion(q) {
  if (!q || !q.question) return null;
  const qtype = ['single', 'multi', 'truefalse', 'fillblank'].includes(q.qtype) ? q.qtype : 'single';
  const out = {
    qtype,
    question: String(q.question),
    difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
    explanation: String(q.explanation || ''),
    learn_more_query: String(q.learn_more_query || q.question),
    source_url: /^https?:\/\/.+/i.test(String(q.source_url || '')) ? String(q.source_url) : '',
    source_title: String(q.source_title || '')
  };
  // Accept both the v2 "correct" array and the legacy "correct_index" field
  let correct = Array.isArray(q.correct) ? q.correct : (Number.isInteger(q.correct_index) ? [q.correct_index] : null);

  if (qtype === 'fillblank') {
    const answers = (correct || []).map(s => String(s).trim()).filter(Boolean);
    if (!answers.length) return null;
    out.options = [];
    out.correct = answers.slice(0, 6);
    out.correct_index = -1;
    return out;
  }

  let options = Array.isArray(q.options) ? q.options.map(String) : null;
  if (qtype === 'truefalse') options = ['True', 'False'];
  if (!options || options.length < 2 || options.length > 6) return null;

  if (!correct || !correct.every(i => Number.isInteger(i) && i >= 0 && i < options.length)) return null;
  correct = [...new Set(correct)].sort((a, b) => a - b);
  if (qtype === 'multi') {
    if (correct.length < 2 || correct.length >= options.length) return null;
  } else {
    if (correct.length !== 1) return null;
    if (qtype === 'single' && options.length !== 4) return null;
  }
  out.options = options;
  out.correct = correct;
  out.correct_index = correct[0];
  return out;
}

function buildPrompt({ title, description, material, count, difficulty, questionTypes, avoid }) {
  const difficultyInstruction =
    difficulty === 'mixed'
      ? 'Vary the difficulty: roughly one third easy, one third medium, one third hard.'
      : `All questions should be ${difficulty} difficulty.`;

  const typeInstruction = questionTypes === 'mixed'
    ? `Mix the question types: roughly 60% "single" (4 options, 1 correct), 15% "multi" (5 options, exactly 2 correct — phrase the question "…? (Choose TWO)"), 15% "truefalse" (a statement; options must be exactly ["True","False"]), 10% "fillblank" (a sentence with one missing term; no options; "correct" lists 1-4 acceptable answers, e.g. ["TCP", "Transmission Control Protocol"]).`
    : `All questions are type "single": exactly 4 options with exactly one correct answer.`;

  const materialBlock = material
    ? `\nBase the questions PRIMARILY on this study material provided by the student (fall back to your own knowledge only to fill gaps):\n<study_material>\n${material.slice(0, MATERIAL_CHAR_LIMIT)}\n</study_material>\n`
    : '';

  const avoidBlock = avoid && avoid.length
    ? `\nThe question set already contains the questions below. Do NOT repeat or closely paraphrase any of them — cover different facts and subareas:\n${avoid.map(t => `- ${t}`).join('\n')}\n`
    : '';

  return `You are an expert exam author. Research the topic below and write high-quality exam questions.

Topic: ${title}
${description ? `Extra context from the student: ${description}` : ''}
${materialBlock}${avoidBlock}
Write exactly ${count} questions. ${difficultyInstruction}

${typeInstruction}

Rules:
- Distractors must be plausible, not obviously wrong.
- Cover the breadth of the topic, not just one subarea.
- "explanation" must explain WHY the correct answer is right AND why the common wrong choices are wrong (2-4 sentences).
- "source_url" must be a real, currently-working URL to an authoritative reference page about THIS question's specific concept. Strongly prefer stable, long-lived pages: the relevant Wikipedia article, official documentation, standards bodies, or well-known educational sites. Use the exact canonical URL (not a homepage, not a search). Only provide a URL you are confident exists.
- "source_title" is the short human-readable title of that page.
- "learn_more_query" is a short web search query, used only as a fallback if the URL is unavailable.

Respond with ONLY a JSON array, no other text:
[
  {
    "qtype": "single|multi|truefalse|fillblank",
    "question": "...",
    "options": ["...", "..."],
    "correct": [0],
    "difficulty": "easy|medium|hard",
    "explanation": "...",
    "source_url": "https://en.wikipedia.org/wiki/...",
    "source_title": "...",
    "learn_more_query": "..."
  }
]`;
}

// Generate `count` questions in batches so large sets never hit response-token limits.
// `existing` = question texts already in the bank (for dedup when appending).
// `onProgress(done, total)` lets the caller surface progress in the topic status.
async function generateQuestions({ title, description, material, count, difficulty, questionTypes, existing = [], onProgress }) {
  const all = [];
  const avoid = existing.slice(-80); // keep the prompt bounded on big banks
  while (all.length < count) {
    const batch = Math.min(BATCH_SIZE, count - all.length);
    const prompt = buildPrompt({ title, description, material, count: batch, difficulty, questionTypes, avoid });
    const text = await callClaude([{ role: 'user', content: prompt }], 12000);
    const raw = extractJson(text);
    if (!Array.isArray(raw)) throw new Error('AI returned no questions');
    const cleaned = raw.map(normalizeQuestion).filter(Boolean);
    if (!cleaned.length) throw new Error('AI returned no usable questions');
    for (const q of cleaned) {
      if (all.length >= count) break;
      all.push(q);
      avoid.push(q.question);
    }
    if (onProgress) onProgress(all.length, count);
  }
  return all;
}

// Check that model-suggested source URLs actually resolve; demote dead ones to ''
// so the UI falls back to a web search link. Never fails the generation.
async function verifySourceUrls(questions, onProgress) {
  const urls = [...new Set(questions.map(q => q.source_url).filter(Boolean))];
  const alive = new Map();
  const check = async url => {
    try {
      for (const method of ['HEAD', 'GET']) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        try {
          const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal,
            headers: { 'user-agent': 'Mozilla/5.0 (ExamPrepper link checker)' } });
          if (res.body && method === 'GET') res.body.cancel?.();
          if (res.status < 400) { alive.set(url, true); return; }
          if (method === 'GET' || ![403, 405, 501].includes(res.status)) { alive.set(url, false); return; }
        } finally { clearTimeout(timer); }
      }
    } catch { alive.set(url, false); }
  };
  for (let i = 0; i < urls.length; i += 10) {
    await Promise.allSettled(urls.slice(i, i + 10).map(check));
    if (onProgress) onProgress(Math.min(i + 10, urls.length), urls.length);
  }
  for (const q of questions) {
    if (q.source_url && alive.get(q.source_url) === false) q.source_url = '';
  }
  return questions;
}

// Answer a student's follow-up question about one exam question.
async function askFollowUp({ topicTitle, question, options, correctText, explanation, history = [], userQuestion }) {
  const context = `You are a friendly, precise tutor helping a student prepare for an exam on "${topicTitle}".
They just worked through this practice question:

Question: ${question}
${options && options.length ? `Options:\n${options.map((o, i) => `${'ABCDEF'[i]}. ${o}`).join('\n')}` : ''}
Correct answer: ${correctText}
Explanation shown to the student: ${explanation}

Answer the student's follow-up questions about this concept. Be accurate and concise (under 200 words), use plain language, and give a small concrete example if it helps. Plain text only (no markdown headers).`;

  const messages = [{ role: 'user', content: context + '\n\nStudent: ' + (history[0]?.q || userQuestion) }];
  // Rebuild the short conversation so Claude keeps context across follow-ups
  for (let i = 0; i < history.length; i++) {
    messages.push({ role: 'assistant', content: history[i].a });
    const nextQ = i + 1 < history.length ? history[i + 1].q : userQuestion;
    messages.push({ role: 'user', content: nextQ });
  }
  return (await callClaude(messages, 1000)).trim();
}

module.exports = { generateQuestions, verifySourceUrls, askFollowUp, normalizeQuestion, getApiKey };
