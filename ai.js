// ai.js — talks to the Claude API to research topics and generate questions
const { getSetting } = require('./db');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6'; // good quality/cost balance for question generation

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

async function generateQuestions(topicTitle, description, numQuestions, difficulty) {
  const difficultyInstruction =
    difficulty === 'mixed'
      ? 'Vary the difficulty: roughly one third easy, one third medium, one third hard.'
      : `All questions should be ${difficulty} difficulty.`;

  const prompt = `You are an expert exam author. Research the topic below from your knowledge and write high-quality multiple-choice exam questions.

Topic: ${topicTitle}
${description ? `Extra context from the student: ${description}` : ''}

Write exactly ${numQuestions} multiple-choice questions. ${difficultyInstruction}

Rules:
- Each question has exactly 4 options with exactly one correct answer.
- Distractors must be plausible, not obviously wrong.
- Cover the breadth of the topic, not just one subarea.
- "explanation" must explain WHY the correct answer is right AND why the common wrong choices are wrong (2-4 sentences).
- "source_url" must be a real, currently-working URL to an authoritative reference page where the student can read more about THIS question's specific concept. Strongly prefer stable, long-lived pages: the relevant Wikipedia article, official documentation, standards bodies, or well-known educational sites. Use the exact canonical URL of the page (not a homepage, not a search). Only provide a URL you are confident exists.
- "source_title" is the short human-readable title of that page (e.g. the article or doc page name).
- "learn_more_query" is a short web search query, used only as a fallback if the URL is unavailable.

Respond with ONLY a JSON array, no other text:
[
  {
    "question": "...",
    "options": ["...", "...", "...", "..."],
    "correct_index": 0,
    "difficulty": "easy|medium|hard",
    "explanation": "...",
    "source_url": "https://en.wikipedia.org/wiki/...",
    "source_title": "...",
    "learn_more_query": "..."
  }
]`;

  const text = await callClaude([{ role: 'user', content: prompt }], 16000);
  const questions = extractJson(text);
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('AI returned no questions');
  }
  // Validate and normalize
  return questions
    .filter(q => q.question && Array.isArray(q.options) && q.options.length === 4 &&
      Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3)
    .map(q => ({
      question: String(q.question),
      options: q.options.map(String),
      correct_index: q.correct_index,
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      explanation: String(q.explanation || ''),
      learn_more_query: String(q.learn_more_query || q.question),
      // Keep a well-formed http(s) URL; otherwise leave blank and let the UI fall back to a search link.
      source_url: /^https?:\/\/.+/i.test(String(q.source_url || '')) ? String(q.source_url) : '',
      source_title: String(q.source_title || '')
    }));
}

module.exports = { generateQuestions, getApiKey };
