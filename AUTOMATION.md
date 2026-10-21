# Question refresh — how it works

The quiz gets a fresh set of 100 questions **at most once a day, and only if
someone actually played the current set** — at least one visitor answered at
least half (50) of its questions. If nobody plays, the set stays as it is and
nothing runs against the LLM API or the repo.

## The pieces

1. **The page** (`index.html`) remembers which questions this device has
   answered for the current set (`SET_ID`), in `localStorage`, so a reload
   doesn't lose progress — and unanswered questions are served first on a
   replay. When the count reaches half the set, it pings a free public
   counter once:
   `https://abacus.jasoncameron.dev/hit/adithyahrudai-sanskrit-quiz/set-<SET_ID>`
   ([Abacus](https://jasoncameron.dev/abacus/) — no account or key needed).
   The start and end screens show the progress towards that mark.

2. **The workflow** (`.github/workflows/daily-questions.yml`) runs at 08:00,
   12:00 and 16:00 IST. Each run calls `scripts/generate-questions.mjs`, which:
   - skips if the current set is already today's (IST);
   - reads the counter for the current set and skips if it's 0;
   - otherwise generates a new set in six small batches (easy / medium / hard ×
     two topic groups, 10 questions per topic), so each API call is quick;
   - drops individual invalid questions (wrong topic, non-Devanagari or Latin
     text, not 4 distinct options, duplicates of the last 30 sets) and asks
     for replacements, rather than throwing away the whole set;
   - sends every batch to a second, temperature-0 "strict reviewer" call that
     flags wrong or ambiguous questions, which are also replaced;
   - only rewrites `index.html` once all 100 are in hand, then commits.

   The 12:00 and 16:00 runs are retries: once the morning run has refreshed,
   they see "already today's set" and exit in seconds.

3. **Providers**: Gemini (`gemini-2.5-flash`), falling back to
   `gemini-2.5-flash-lite` (separate free quota) when the first is overloaded,
   then Groq if a `GROQ_API_KEY` is set. 429/5xx/timeouts are retried with
   backoff; a bad key or unknown model is skipped immediately.

## When will I get a failure email?

Only when something is actually broken:

- **Transient problems** (API overloaded, timeouts, counter unreachable) on the
  08:00 or 12:00 run only log a warning — the next run retries. If the 16:00
  run still can't refresh, that run fails and you get an email. The set is
  still pending, so the next day's 08:00 run tries again.
- **Permanent problems** (no/invalid API key, `index.html` markers missing)
  fail on any run.
- Manual runs always report failures.

If a run fails, the live quiz keeps serving the last good set.

## Inactivity keepalive

GitHub disables scheduled workflows in public repos after 60 days without
repository activity, which would now happen whenever nobody plays for two
months. Each scheduled run calls the "enable workflow" API on itself to reset
that timer, so no keepalive commits are needed.

## Secrets

Only `GEMINI_API_KEY` is required (already set). Optional:

| Secret | Purpose |
| --- | --- |
| `GEMINI_MODEL` | Override the primary Gemini model (default `gemini-2.5-flash`) |
| `GEMINI_FALLBACK_MODEL` | Override the fallback model (default `gemini-2.5-flash-lite`) |
| `GROQ_API_KEY` | Adds Groq as a last-resort provider ([free key](https://console.groq.com/keys)) |
| `GROQ_MODEL` | Override the Groq model (default `llama-3.3-70b-versatile`) |

```
gh secret set GROQ_API_KEY --repo AdithyaHrudai/sanskrit-quiz
```

Note: as of mid-2026, `gemini-2.0-flash`/`gemini-2.0-flash-lite` have no
free-tier quota on new keys (`limit: 0`) — stick to `gemini-2.5-*` or newer.

## Manual runs and checks

Force a refresh regardless of activity (Actions tab → "Daily question
refresh" → Run workflow → tick *force*), or:

```
gh workflow run daily-questions.yml --repo AdithyaHrudai/sanskrit-quiz -f force=true
gh run watch --repo AdithyaHrudai/sanskrit-quiz
```

Each run's outcome (skipped / refreshed / failed, and why) is shown on its
summary page. See how many visitors got past halfway on a set:

```
curl https://abacus.jasoncameron.dev/get/adithyahrudai-sanskrit-quiz/set-2026-10-20
```

(404 means nobody yet.) `data/last-run.json` records the latest refresh, and
each set is archived to `data/questions-archive/YYYY-MM-DD.json` (newest 30
kept; also used to avoid repeating questions).

Offline tests: `node scripts/test-dryrun.mjs`.

## Tuning

- Threshold: `NEED` in `index.html` (half the set).
- Schedule: the `cron` lines in the workflow — keep `FINAL_ATTEMPT` pointing
  at the last slot.
- Topics / batch sizes: `ALLOWED_TOPICS` and `BATCHES` in
  `scripts/generate-questions.mjs`. The start-screen topic chips follow
  whatever topics the set actually contains.
