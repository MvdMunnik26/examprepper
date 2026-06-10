# 🎓 ExamPrepper

An AI-powered exam preparation webapp. Add any exam topic, and Claude researches it and generates a multiple-choice question set for you. Practice in a timed mock exam or a relaxed review mode, get explanations for every answer, and dive deeper into any concept with AI-written study articles.

## Features

- **Multi-user** with username/password login. The first account you register automatically becomes the admin.
- **AI question generation** — give it any topic ("AWS Solutions Architect", "Dutch history", "TCP/IP networking") and it generates multiple-choice questions of varying difficulty with explanations.
- **Two practice modes:**
  - ⏱ **Mock exam** — timed, no feedback until you submit, then a score and full answer review.
  - 📖 **Review mode** — no timer, instant feedback with an explanation after every answer.
- **Deep dives** — every explanation links to an AI-written study article about that question's concept, plus a web search link to explore further.
- **Per-topic settings** — change the number of questions (5–50), difficulty (easy/medium/hard/mixed), and the exam timer. Applied next time you generate questions.
- **Admin section** — manage users (promote/demote admin, reset passwords, delete), manage all exam topics, and configure the API key.
- **Dark & light theme** — toggle with the 🌙/☀️ button; your choice is remembered.

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
3. Back on the dashboard, click **+ New topic**, enter your exam subject, and the app will research it and generate questions (takes ~30–60 seconds).
4. Start a **Mock exam** or **Review** session.

> Alternatively you can set the API key as an environment variable `ANTHROPIC_API_KEY` instead of entering it in the admin panel.

## Using it from other devices

The app listens on port 3000. Anyone on your network can use it at `http://<your-pc-ip>:3000` (e.g. `http://192.168.1.50:3000`) — each person registers their own account and gets their own topics. You may need to allow port 3000 through Windows Firewall.

To use a different port: `set PORT=8080 && npm start` (Windows) or `PORT=8080 npm start` (Linux/Mac).

## How it's built (for the curious)

| File | What it does |
|---|---|
| `server.js` | Express web server: login/sessions, all API routes, admin endpoints |
| `db.js` | SQLite database (uses Node's built-in SQLite — no native compilation needed). Data is stored in `examprepper.db`, created automatically on first run |
| `ai.js` | Talks to the Claude API: researches topics, generates questions and deep-dive articles |
| `public/` | The frontend — a single-page app in plain HTML/CSS/JS, no frameworks |

The flow for question generation: you click *Generate* → the server asks Claude to act as an exam author and return questions as JSON → the server validates them and stores them in SQLite → the browser polls the status every few seconds and refreshes when ready.

Passwords are stored hashed (bcrypt). Answer scoring happens server-side. Deep-dive articles are cached in the database, so each one is only generated (and paid for) once.

## Backup

Everything lives in one file: `examprepper.db`. Copy it to back up all users, topics, questions, and results.
