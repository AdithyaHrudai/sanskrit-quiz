# Question refresh — how it works

The quiz gets a fresh set of 100 questions **at most once a day, and only if
someone actually played the current set** — at least one visitor answered at
least half (50) of its questions. If nobody plays, the set stays as it is and
nothing runs against the LLM API or the repo.

## The pieces

1. **The page** (`index.html`) remembers which questions this device has
   answered for the current set (`SET_ID`), in `localStorage`, so a reload
   doesn't lose progress. The question order is reshuffled every time the quiz
   is started. When the count reaches half the set, it pings a free public
   counter once:
   `https://abacus.jasoncameron.dev/hit/adithyahrudai-sanskrit-quiz/set-<SET_ID>`
   ([Abacus](https://jasoncameron.dev/abacus/) — no account or key needed).
   The start and end screens show the progress towards that mark.

2. **The workflow** (`.github/workflows/daily-questions.yml`) runs at 08:00,
   12:00 and 16:00 IST. Each run calls `scripts/generate-questions.mjs`, which:
   - skips if the current set is already today's (IST);
   - reads the counter for the current set and skips if it's 0;
   - otherwise builds a new set (below), and only then rewrites `index.html`
     and commits.

   The 12:00 and 16:00 runs are retries: once the morning run has refreshed,
   they see "already today's set" and exit in seconds. (GitHub often starts
   scheduled runs hours late — that's fine, nothing depends on the exact time.)

3. **Building a set** is designed around the Gemini free tier, which allows
   only **20 requests per day per model**. A refresh needs about **4 calls**:
   - 3 generation calls — one per difficulty (30 easy / 40 medium / 30 hard),
     each covering all 10 topics with one spare question per topic, and told
     to avoid every question from the last 10 sets;
   - 1 review call — a temperature-0 "scholar" pass over every candidate,
     flagging wrong, ambiguous or answer-revealing questions. It goes to a
     different model than the one that wrote them when one is available (a
     model tends to repeat its own mistakes when checking itself);
   - rejected or invalid questions (non-Devanagari/Latin text, not 4 distinct
     options, repeats) are replaced from the spares, so normally no further
     calls are needed. Only if the spares run out are up to 3 small top-up
     calls (plus one more review) made. A reply that was cut off mid-way still
     yields its complete questions;
   - the result is exactly 10 questions per topic; a set is published if at
     least 90 usable questions come out.

4. **Models**: each Gemini model has its own daily quota, so the script tries a
   chain — `gemini-3-flash-preview`, `gemini-2.5-flash`, `gemini-flash-latest`,
   `gemini-2.5-flash-lite` — and moves on when one is out of quota, retired
   (404) or overloaded. Per-minute rate limits (calls are spaced 13 s apart)
   are waited out rather than falling back. Groq is a last resort if
   `GROQ_API_KEY` is set. If the review call fails, the set is still published
   and `data/last-run.json` says `"reviewed": false`.

## When will I get a failure email?

GitHub only emails when a run is marked failed, so that is reserved for
problems that need you (`shouldFail()` in `scripts/generate-questions.mjs`):

- **Ordinary flakiness** (API overloaded, quota used up, timeouts, counter
  temporarily unreachable) only logs a warning and the run stays green. The
  next scheduled run — or tomorrow's — retries on its own, and the live quiz
  keeps serving the current set meanwhile.
- **A refresh that stays undone for 3 mornings** (played set is 3+ days old) is
  reported as failed by the 16:00 run, so a quietly dead pipeline can't go
  unnoticed.
- **Real breakage** fails immediately: no/invalid API key, `index.html` markers
  missing, unexpected code errors, a failed push.
- **Manual runs** always report failures.

## Inactivity keepalive

GitHub disables scheduled workflows in public repos after 60 days without
repository activity, which would now happen whenever nobody plays for two
months. Each scheduled run calls the "enable workflow" API on itself to reset
that timer, so no keepalive commits are needed.

## Configuration

Only the `GEMINI_API_KEY` secret is required (already set). Optional:

| Name | Kind | Purpose |
| --- | --- | --- |
| `GEMINI_MODELS` | variable | Comma-separated Gemini model chain, best first (replaces the default chain) |
| `GROQ_API_KEY` | secret | Adds Groq as a last-resort provider ([free key](https://console.groq.com/keys)) |
| `GROQ_MODEL` | secret | Override the Groq model (default `llama-3.3-70b-versatile`) |

```
gh variable set GEMINI_MODELS --repo AdithyaHrudai/sanskrit-quiz --body "gemini-2.5-flash,gemini-3-flash-preview"
gh secret set GROQ_API_KEY --repo AdithyaHrudai/sanskrit-quiz
```

Preview models can be retired without notice; a model that returns 404 is
skipped automatically. Daily quotas reset at midnight Pacific (07:00 UTC).

## Manual runs and checks

Force a refresh regardless of activity (Actions tab → "Daily question
refresh" → Run workflow → tick *force*), or:

```
gh workflow run daily-questions.yml --repo AdithyaHrudai/sanskrit-quiz -f force=true
gh run watch --repo AdithyaHrudai/sanskrit-quiz
```

Each run's outcome (skipped / refreshed / failed, and why) is shown on its
summary page. See whether anyone got past halfway on a set:

```
curl https://abacus.jasoncameron.dev/get/adithyahrudai-sanskrit-quiz/set-2026-10-20
```

(404 means nobody yet.) `data/last-run.json` records the latest refresh
(including how many API calls it took), and each set is archived to
`data/questions-archive/YYYY-MM-DD.json` (newest 30 kept; the newest 10 are
used to avoid repeating questions).

Offline tests: `node scripts/test-dryrun.mjs`.

## Tuning

- Threshold: `NEED` in `index.html` (half the set).
- Schedule: the `cron` lines in the workflow — keep `FINAL_ATTEMPT` pointing
  at the last slot.
- Topics / set size: `ALLOWED_TOPICS` and `DIFFICULTY_COUNTS` in
  `scripts/generate-questions.mjs`. The start-screen topic chips follow
  whatever topics the set actually contains.
