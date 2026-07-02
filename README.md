# 🎓 ExamPrepper

An AI-powered exam preparation webapp. Add any exam topic, and Claude researches it and generates a question set for you — optionally grounded in your own study material. Practice in a timed mock exam, a relaxed review mode, or a weak-spot drill that targets exactly the questions you keep getting wrong. Track your progress over time and ask the AI tutor follow-up questions about any answer.

## Features

- **Multi-user** with username/password login. The first account you register automatically becomes the admin.
- **AI question generation** — give it any topic ("AWS Solutions Architect", "Dutch history", "TCP/IP networking") and it generates questions of varying difficulty with explanations. Large sets are generated in batches, and every source link is verified before it's saved.
- **Bring your own material** — paste your notes, syllabus or a textbook chapter (or load a `.txt`/`.md` file) and questions are based on *your* material instead of general knowledge.
- **Four question types** — classic multiple choice, multi-select ("choose TWO"), true/false, and fill-in-the-blank (enable *Mixed* in the topic settings).
- **Three practice modes:**
  - ⏱ **Mock exam** — timed (server-side), no feedback until you submit. Flag questions for review and jump around with the question navigator, just like real exam software.
  - 📖 **Review mode** — no timer, instant feedback with an explanation after every answer.
  - 🎯 **Weak-spot drill** — automatically drills the questions you've gotten wrong until you answer them correctly twice in a row.
- **Never lose an exam** — sessions survive a page refresh or accidental navigation. The timer keeps running server-side and you resume exactly where you left off (answer and question order stay identical).
- **Progress tracking** — per-topic attempt history, a mock-exam score trend chart, and a readiness indicator based on your last three exam scores.
- **AI tutor follow-ups** — after any answer, ask the AI follow-up questions about the concept ("why is B wrong here?") right inside the explanation.
- **Question bank** — browse, edit, hand-write, or delete individual questions. Add extra AI questions to an existing set (deduplicated automatically) instead of regenerating everything.
- **Shared topics & leaderboard** — share a topic so everyone on your server can practice it (one generation, many students) and compete on its per-topic leaderboard.
- **Fair repeat practice** — question *and* answer-option order are shuffled per session, so you learn concepts, not letter positions.
- **Keyboard shortcuts** — `1–5` answer, `←`/`→` navigate, `F` flag, `Enter` check/next.
- **Deep dives** — every explanation links to a verified source page about that question's concept, plus a web search fallback.
- **Admin section** — manage users (promote/demote admin, reset passwords, delete), manage all exam topics, and configure the API key.
- **Dark & light theme** — toggle with the 🌙/☀️ button; your choice is remembered.
- **Mobile-first & installable** — fully responsive (bottom-sheet dialogs, thumb-reach quiz controls, big tap targets) with a web manifest so it can be added to a phone's home screen.
- **Search-engine ready** — a crawlable public landing page with structured data (SoftwareApplication + FAQ), Open Graph/social cards, sitemap.xml, robots.txt, canonical URLs, gzip compression and long-lived asset caching.

## Requirements

- **Node.js 22.5 or newer** — download from [nodejs.org](https://nodejs.org) (the LTS version is fine).
- **An Anthropic API key** — create one at [console.anthropic.com](https://console.anthropic.com). Generating one exam costs a few cents.

## Getting started

Open a terminal in this folder and run:

```
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

1. **Register** your account — the first account becomes admin.
2. Go to **Admin → Settings** and paste your Anthropic API key.
3. Back on the dashboard, click **+ New topic**, enter your exam subject (and optionally paste your study material), and the app will research it and generate questions (takes ~30–60 seconds).
4. Start a **Mock exam** or **Review** session. After a few attempts, use the **Weak spots** drill and watch your trend chart climb.

> Alternatively you can set the API key as an environment variable `ANTHROPIC_API_KEY` instead of entering it in the admin panel.

## Using it from other devices

The app listens on port 3000. Anyone on your network can use it at `http://<your-pc-ip>:3000` (e.g. `http://192.168.1.50:3000`) — each person registers their own account and gets their own topics. Share a topic in its settings to let everyone practice the same question set and compete on the leaderboard. You may need to allow port 3000 through Windows Firewall.

To use a different port: `set PORT=8080 && npm start` (Windows) or `PORT=8080 npm start` (Linux/Mac).

## How it's built (for the curious)

| File | What it does |
|---|---|
| `server.js` | Express web server: login/sessions, quiz sessions & scoring, all API routes, admin endpoints |
| `db.js` | SQLite database (uses Node's built-in SQLite — no native compilation needed). Data is stored in `examprepper.db`, created automatically on first run; schema migrations run automatically on upgrade |
| `ai.js` | Talks to the Claude API: researches topics, generates questions in batches, verifies source links, answers follow-up questions |
| `public/` | The frontend — a single-page app in plain HTML/CSS/JS, no frameworks |

Some design notes:

- **Exam integrity**: in mock-exam mode the browser never receives the correct answers — scoring happens server-side and the full answer review only arrives after you submit. Exam duration is measured server-side too.
- **Deterministic shuffling**: each quiz session stores a random seed; question and option order are derived from it, so a resumed session looks identical and submitted answers are mapped back to canonical option indices for scoring.
- **Weak-spot tracking**: every answered question updates a per-user stats row (correct/wrong counts + streak). A question leaves the weak pool once you've answered it correctly twice in a row.
- Passwords are stored hashed (bcrypt). Prepared statements everywhere. Answer scoring happens server-side.

## Upgrading from v1

Just pull and restart — the database schema migrates automatically on startup. Existing topics, questions, users and attempts are preserved (old questions become type `single`).

## Backup

Everything lives in one file: `examprepper.db`. Copy it to back up all users, topics, questions, and results.
