# Daily question refresh — setup

Every day at 02:30 UTC (08:00 IST), a GitHub Actions workflow
(`.github/workflows/daily-questions.yml`) runs `scripts/generate-questions.mjs`,
which:

1. Calls a free LLM API (Groq or Gemini — whichever key you've configured) to
   generate 100 new Sanskrit MCQs (30 easy / 40 medium / 30 hard) across the
   quiz's topics.
2. Validates the response strictly: exact question count, exact difficulty
   split, Devanagari-only text, exactly 4 options per question, no duplicates,
   only allowed topic keys.
3. If valid, rewrites the `T` and `BANK` blocks in `index.html` (between the
   `AUTO-GENERATED` marker comments) and commits + pushes.
4. If invalid after 4 retries, it leaves `index.html` untouched and the
   workflow run shows as failed — **the live quiz is never overwritten with
   broken content.**

This costs nothing: GitHub Actions is free for public repos, and both Groq
and Gemini offer a free API tier that comfortably covers one generation call
per day.

## One-time setup

You need exactly one of these two secrets set on the repo. Only one is
required — the script prefers Groq if both are present.

### Option A — Groq (recommended, fast, generous free tier)

1. Get a free key at https://console.groq.com/keys
2. Add it as a repo secret:
   ```
   gh secret set GROQ_API_KEY --repo AdithyaHrudai/sanskrit-quiz
   ```
   (paste the key when prompted), or via GitHub web UI:
   Settings → Secrets and variables → Actions → New repository secret →
   name `GROQ_API_KEY`.

### Option B — Gemini

1. Get a free key at https://aistudio.google.com/apikey
2. Add it as a repo secret named `GEMINI_API_KEY` the same way as above.

## Test it manually

Don't wait for the cron — trigger it on demand from the Actions tab
("Daily question refresh" → Run workflow), or via CLI:

```
gh workflow run daily-questions.yml --repo AdithyaHrudai/sanskrit-quiz
gh run watch --repo AdithyaHrudai/sanskrit-quiz
```

Check `data/last-run.json` after a run for a quick status summary (date,
provider, pass/fail, topic distribution). Each day's raw generated question
set is also archived to `data/questions-archive/YYYY-MM-DD.json` for audit
(auto-pruned after 30 days).

## Changing the model or schedule

- Model: set `GROQ_MODEL` or `GEMINI_MODEL` as an extra repo secret/variable
  to override the defaults (`llama-3.3-70b-versatile` / `gemini-2.0-flash`).
- Schedule: edit the `cron` line in `.github/workflows/daily-questions.yml`.
- Topics: edit `ALLOWED_TOPICS` in `scripts/generate-questions.mjs` — the
  start-screen topic chips are regenerated automatically to match whatever
  topics actually appear in that day's 100 questions.
