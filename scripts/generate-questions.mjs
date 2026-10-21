#!/usr/bin/env node
// Question-bank refresh for the Sanskrit quiz, run by
// .github/workflows/daily-questions.yml.
//
// The set refreshes at most once per day (IST), and only if it was actually
// played: index.html pings a public Abacus counter (key `set-<SET_ID>`) once a
// visitor has answered at least half of the current set. If nobody has, this
// script exits quietly without calling any LLM or touching the repo.
//
// When a refresh is due, 100 questions are generated in six small batches
// (one per difficulty × topic group) so each call is fast. Each batch is then
// fact-checked by a second, temperature-0 review call; invalid or flagged
// questions are dropped and topped up instead of failing the whole set.
// index.html is only rewritten once all 100 are in hand, so the live quiz
// always keeps serving the last known-good set.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const SET_START = '/* AUTO-GENERATED:SET:START — overwritten by scripts/generate-questions.mjs, do not hand-edit */';
const SET_END = '/* AUTO-GENERATED:SET:END */';
const TOPICS_START = '/* AUTO-GENERATED:TOPICS:START — overwritten daily by scripts/generate-questions.mjs, do not hand-edit */';
const TOPICS_END = '/* AUTO-GENERATED:TOPICS:END */';
const QUESTIONS_START = '/* AUTO-GENERATED:QUESTIONS:START — overwritten daily by scripts/generate-questions.mjs, do not hand-edit */';
const QUESTIONS_END = '/* AUTO-GENERATED:QUESTIONS:END */';

// Must match COUNTER_NS in index.html.
export const COUNTER_NS = 'adithyahrudai-sanskrit-quiz';
const COUNTER_BASE = 'https://abacus.jasoncameron.dev';

// Source of truth for allowed topics — keep in sync with what the prompt offers the model.
export const ALLOWED_TOPICS = {
  vy: { label: 'व्याकरणम्', desc: 'Sanskrit grammar (sandhi, vibhakti, samasa, karaka, lakara, dhatu/pratyaya, Paninian sutras)' },
  pu: { label: 'पुराणकथा', desc: 'Puranic stories (Ramayana, Mahabharata, Bhagavata, other Puranas)' },
  de: { label: 'देवतायाः', desc: 'Deities — their vahana, weapons, names, relationships' },
  gk: { label: 'भारतज्ञानम्', desc: 'Indian general knowledge — national symbols, geography, culture, Vedas/Upanishads' },
  wg: { label: 'विश्वज्ञानम्', desc: 'World knowledge — geography, oceans, mountains, rivers, records' },
  rc: { label: 'राजधानीज्ञानम्', desc: 'Capital cities of countries and Indian states' },
  it: { label: 'इतिहासः', desc: 'Indian history — dynasties, kings, historical figures' },
  su: { label: 'सुभाषितपूर्तिः', desc: 'Fill-in-the-blank completions of well-known subhashitas' },
  sh: { label: 'शब्दज्ञानम्', desc: 'Sanskrit synonyms (paryayapada)' },
  sa: { label: 'साहित्यम्', desc: 'Classical Sanskrit literature — Kalidasa, Bhasa, kavya/nataka works and authors' },
};

const DIFFICULTY = [
  'easy — well-known facts a casual Sanskrit learner would know',
  'medium — needs solid familiarity with the subject',
  'hard — for serious students and scholars; precise, lesser-known but well-established facts',
];

// Two topic groups × three difficulties = six batches, 10 questions per topic.
const GROUP_A = ['vy', 'pu', 'de', 'gk', 'wg'];
const GROUP_B = ['rc', 'it', 'su', 'sh', 'sa'];
export const BATCHES = [
  { d: 0, n: 15, topics: GROUP_A }, { d: 0, n: 15, topics: GROUP_B },
  { d: 1, n: 20, topics: GROUP_A }, { d: 1, n: 20, topics: GROUP_B },
  { d: 2, n: 15, topics: GROUP_A }, { d: 2, n: 15, topics: GROUP_B },
];
export const TOTAL = BATCHES.reduce((s, b) => s + b.n, 0);

const ROUNDS_PER_BATCH = 6;        // top-up calls per batch before giving up
const EXTRA_PER_CALL = 3;          // ask for a few spare questions to absorb drops
const TRIES_PER_PROVIDER = 3;      // per call, on 5xx/timeouts, before falling back
const BACKOFF_MS = [20_000, 60_000];
// Free-tier quotas are per minute per model, and a refresh makes ~15 calls
// (generate + review per batch), so calls to one model are spaced out and a
// rate-limited call waits as long as the API asks instead of falling back to
// the weaker model (seen live: bursts of 429s, and flash-lite's hard questions
// mostly rejected by the reviewer).
const MIN_GAP_MS = 13_000;         // ≤ ~4.6 requests/minute per model
const RATE_LIMIT_WAITS = 6;        // per call, on per-minute 429s
const MAX_RATE_WAIT_MS = 90_000;
const CALL_TIMEOUT_MS = 180_000;
const BUDGET_MS = 30 * 60_000;     // stays well inside the workflow's 45-minute job timeout
const ARCHIVE_KEEP = 30;
// Questions from the newest RECENT_SETS sets are never repeated, and the ones
// matching a batch are shown to the model so it doesn't propose them. Easy
// questions draw on a small pool of famous facts, so a longer window starves
// the easy batches (seen live: most candidates were exact repeats).
const RECENT_SETS = 10;

const DEVANAGARI_RE = /[ऀ-ॿ]/;
const LATIN_RE = /[A-Za-z]/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class GenerationError extends Error {
  constructor(message, transient) {
    super(message);
    this.transient = transient;
  }
}

// IST calendar date — the quiz's audience is in India, so "a day" is an IST day.
export function istDate(now = new Date()) {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function readSetId(html) {
  return html.match(/const SET_ID = '(\d{4}-\d{2}-\d{2})';/)?.[1] ?? null;
}

export function normalize(text) {
  return text.replace(/[\s।॥?!.,;:'"‘’“”()\-—_]/g, '');
}

export function stripFences(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
  }
  return t.trim();
}

/* ---------- activity check ---------- */

export async function readPlayCount(setId, fetchFn = fetch, retryDelayMs = 5_000) {
  const url = `${COUNTER_BASE}/get/${COUNTER_NS}/set-${setId}`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return 0;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { value } = await res.json();
      return Number(value) || 0;
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(retryDelayMs);
    }
  }
  throw new GenerationError(`Could not read play counter ${url}: ${lastErr.message}`, true);
}

/* ---------- LLM providers ---------- */

// Reads which quota was hit and how long to wait from a 429 body (Gemini puts
// QuotaFailure + RetryInfo in error.details) or a Retry-After header (Groq).
export function rateLimitError(body, retryAfterHeader) {
  let details = [];
  let message = '';
  try {
    const err = JSON.parse(body).error ?? {};
    details = Array.isArray(err.details) ? err.details : [];
    message = String(err.message ?? '');
  } catch {
    message = body;
  }
  const quotaIds = details.flatMap(d => (d.violations ?? []).map(v => v.quotaId)).filter(Boolean);
  const retryDelay = details.find(d => d.retryDelay)?.retryDelay ?? message.match(/retry in ([\d.]+)s/i)?.[1];
  const seconds = parseFloat(retryDelay ?? retryAfterHeader);
  const e = new GenerationError(
    `HTTP 429 (${quotaIds.join(', ') || 'rate limited'}${Number.isFinite(seconds) ? `, retry in ${Math.ceil(seconds)}s` : ''})`,
    true
  );
  e.rateLimited = true;
  e.daily = quotaIds.some(id => /PerDay/i.test(id));
  e.retryAfterMs = Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
  return e;
}

async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GenerationError(`request failed: ${e.name === 'TimeoutError' ? `timed out after ${CALL_TIMEOUT_MS / 1000}s` : e.message}`, true);
  }
  const text = await res.text();
  if (res.status === 429) throw rateLimitError(text, res.headers.get('retry-after'));
  if (!res.ok) {
    // 5xx is worth retrying; anything else (bad key, unknown model) won't fix itself.
    throw new GenerationError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status >= 500);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GenerationError(`non-JSON API response: ${text.slice(0, 200)}`, true);
  }
}

function geminiProvider(model, key) {
  return {
    name: `gemini:${model}`,
    async call(prompt, { temperature }) {
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { 'x-goog-api-key': key },
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, responseMimeType: 'application/json' },
        }
      );
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
      if (!text) throw new GenerationError(`empty response (finishReason: ${data.candidates?.[0]?.finishReason ?? 'none'})`, true);
      return text;
    },
  };
}

function groqProvider(model, key) {
  return {
    name: `groq:${model}`,
    async call(prompt, { temperature }) {
      const data = await postJson(
        'https://api.groq.com/openai/v1/chat/completions',
        { Authorization: `Bearer ${key}` },
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          response_format: { type: 'json_object' },
        }
      );
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new GenerationError('empty response', true);
      return text;
    },
  };
}

// Gemini first (stronger at Sanskrit), then its lighter model (separate quota),
// then Groq if a key is configured.
export function buildProviders(env) {
  const providers = [];
  if (env.GEMINI_API_KEY) {
    const primary = env.GEMINI_MODEL || 'gemini-2.5-flash';
    const fallback = env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite';
    providers.push(geminiProvider(primary, env.GEMINI_API_KEY));
    if (fallback !== primary) providers.push(geminiProvider(fallback, env.GEMINI_API_KEY));
  }
  if (env.GROQ_API_KEY) providers.push(groqProvider(env.GROQ_MODEL || 'llama-3.3-70b-versatile', env.GROQ_API_KEY));
  return providers;
}

// p.out marks a provider unusable for the rest of the run: 'permanent' (bad
// key, unknown model) or 'quota' (daily quota spent — fine again tomorrow).
async function generateText(prompt, { providers, log, backoffMs, deadline, minGapMs = MIN_GAP_MS }, temperature = 0.9) {
  let lastErr = null;
  const checkBudget = () => {
    if (Date.now() > deadline) throw new GenerationError('time budget exhausted', true);
  };
  for (const p of providers) {
    let failures = 0, waits = 0;
    while (!p.out && failures < TRIES_PER_PROVIDER) {
      checkBudget();
      const gap = (p.lastCall ?? 0) + minGapMs - Date.now();
      if (gap > 0) await sleep(gap);
      checkBudget();
      p.lastCall = Date.now();
      try {
        return { text: await p.call(prompt, { temperature }), provider: p.name };
      } catch (e) {
        lastErr = e;
        log(`  [${p.name}] ${e.message}`);
        if (e.transient === false) p.out = 'permanent';
        else if (e.rateLimited && e.daily) p.out = 'quota';
        else if (e.rateLimited && waits < RATE_LIMIT_WAITS) {
          waits++;
          await sleep(Math.min(e.retryAfterMs ?? backoffMs[0], MAX_RATE_WAIT_MS));
        } else if (++failures < TRIES_PER_PROVIDER) {
          await sleep(backoffMs[Math.min(failures - 1, backoffMs.length - 1)]);
        }
      }
    }
  }
  const allPermanent = providers.every(p => p.out === 'permanent');
  throw new GenerationError(`all providers failed (last error: ${lastErr?.message ?? 'none configured'})`, !allPermanent);
}

/* ---------- prompting & validation ---------- */

export function buildPrompt({ d, n, topics, avoid = [] }) {
  const per = Math.ceil(n / topics.length);
  const topicLines = topics.map(k => `  - "${k}": ${ALLOWED_TOPICS[k].label} — ${ALLOWED_TOPICS[k].desc}`).join('\n');
  const avoidBlock = avoid.length
    ? `\nThese questions already exist — do not repeat or rephrase any of them:\n${avoid.map(q => `  - ${q}`).join('\n')}\n`
    : '';

  return `You are a Sanskrit quizmaster writing for Sanskrit enthusiasts. Write exactly ${n} multiple-choice questions entirely in Sanskrit (Devanagari script only — no English, no transliteration, no Latin letters anywhere).

Difficulty of every question: ${DIFFICULTY[d]}.

Topic keys — use ONLY these, about ${per} questions each:
${topicLines}

Question rules:
  - Every question must be factually accurate and unambiguous — only well-established facts. Do not invent facts.
  - Exactly 4 answer options per question, all plausible, all distinct, all in Sanskrit.
  - The FIRST option in "a" must be the correct answer (the app shuffles options before display).
  - No duplicate or near-duplicate questions.
  - No numbering or labels inside the "q" text, and no hint of the answer in it.
${avoidBlock}
Output STRICT JSON only — no markdown fences, no commentary. Shape exactly:
{"questions":[{"t":"${topics[0]}","q":"...","a":["सम्यक् उत्तरम्","अशुद्धम् १","अशुद्धम् २","अशुद्धम् ३"]}]}`;
}

export function checkQuestion(item, topics) {
  if (!item || typeof item !== 'object') return 'not an object';
  const { t, q, a } = item;
  if (!topics.includes(t)) return `topic "${t}" not allowed in this batch`;
  if (typeof q !== 'string' || !q.trim() || !DEVANAGARI_RE.test(q)) return 'question text missing or not in Devanagari';
  if (LATIN_RE.test(q)) return 'question contains Latin letters';
  if (!Array.isArray(a) || a.length !== 4 || a.some(o => typeof o !== 'string' || !o.trim())) return 'needs exactly 4 non-empty options';
  if (a.some(o => LATIN_RE.test(o)) || !a.some(o => DEVANAGARI_RE.test(o))) return 'options not in Devanagari';
  if (new Set(a.map(o => normalize(o))).size !== 4) return 'options are not distinct';
  return null;
}

// Parses one batch response and returns the usable questions (up to `limit`),
// skipping invalid ones and anything already in `seen` (normalized text).
export function parseBatch(raw, { d, topics }, seen, limit) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (e) {
    return { questions: [], errors: [`response was not valid JSON: ${e.message}`] };
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(list)) return { questions: [], errors: ['"questions" is not an array'] };

  const questions = [];
  const errors = [];
  for (const [i, item] of list.entries()) {
    if (questions.length >= limit) break;
    const problem = checkQuestion(item, topics);
    if (problem) { errors.push(`#${i}: ${problem}`); continue; }
    const key = normalize(item.q);
    if (seen.has(key)) { errors.push(`#${i}: duplicate`); continue; }
    seen.add(key);
    questions.push({ t: item.t, d, q: item.q.trim(), a: item.a.map(s => s.trim()) });
  }
  return { questions, errors };
}

export function buildReviewPrompt(questions) {
  const list = questions
    .map((q, i) => `${i}. ${q.q}\n   claimed correct: ${q.a[0]}\n   other options: ${q.a.slice(1).join(' | ')}`)
    .join('\n');
  return `You are a strict Sanskrit scholar reviewing quiz questions before publication. For each numbered question below, the "claimed correct" option is presented as the only right answer.

Flag a question if ANY of these hold:
  - the claimed correct answer is wrong, doubtful, or only true by some traditions;
  - another option is also correct or arguably correct;
  - the question is ambiguous, ungrammatical, or ill-formed Sanskrit;
  - the question text gives away the answer.
When in doubt, flag it.

${list}

Output STRICT JSON only: {"bad":[<indices of flagged questions>]}`;
}

// Second-opinion fact check. Best-effort: if the review call itself fails, the
// candidates are kept rather than failing the run over a quality pass.
async function reviewQuestions(questions, ctx) {
  if (!questions.length) return { keep: questions, flagged: 0 };
  let text;
  try {
    ({ text } = await generateText(buildReviewPrompt(questions), ctx, 0));
  } catch (e) {
    ctx.log(`  review skipped: ${e.message}`);
    return { keep: questions, flagged: 0 };
  }
  let bad;
  try {
    bad = JSON.parse(stripFences(text)).bad;
  } catch {
    bad = null;
  }
  if (!Array.isArray(bad)) {
    ctx.log('  review skipped: unparseable reviewer response');
    return { keep: questions, flagged: 0 };
  }
  const badSet = new Set(bad.map(Number));
  const keep = questions.filter((_, i) => !badSet.has(i));
  return { keep, flagged: questions.length - keep.length };
}

async function fillBatch(batch, ctx) {
  const got = [];
  const used = new Set();
  const prior = ctx.recent.filter(q => q.d === batch.d && batch.topics.includes(q.t)).map(q => q.q);

  for (let round = 1; round <= ROUNDS_PER_BATCH && got.length < batch.n; round++) {
    const need = batch.n - got.length;
    const ask = need + Math.max(EXTRA_PER_CALL, Math.ceil(need / 4));
    const prompt = buildPrompt({ ...batch, n: ask, avoid: [...prior, ...got.map(q => q.q)] });
    const { text, provider } = await generateText(prompt, ctx);
    used.add(provider);
    // Rejected questions stay in `seen`, so a wrong one proposed again is dropped too.
    const { questions, errors } = parseBatch(text, batch, ctx.seen, ask);
    const { keep, flagged } = await reviewQuestions(questions, ctx);
    got.push(...keep.slice(0, need));
    const notes = [errors.length && `dropped ${errors.length} (${errors.slice(0, 3).join('; ')})`, flagged && `review flagged ${flagged}`]
      .filter(Boolean).join(', ');
    ctx.log(`  round ${round} via ${provider}: +${Math.min(keep.length, need)} (${got.length}/${batch.n})${notes ? ` — ${notes}` : ''}`);
  }

  if (got.length < batch.n) {
    throw new GenerationError(`batch d=${batch.d} [${batch.topics}] only produced ${got.length}/${batch.n} valid questions`, true);
  }
  return { questions: got, providers: [...used] };
}

/* ---------- index.html rewriting ---------- */

export function buildSetBlock(setId) {
  return `const SET_ID = '${setId}';`;
}

export function buildTopicsBlock(usedKeys) {
  const lines = usedKeys.map(k => `  ${k}: '${ALLOWED_TOPICS[k].label}'`).join(',\n');
  return `const T = {\n${lines}\n};`;
}

export function buildQuestionsBlock(questions, meta) {
  const ordered = [0, 1, 2].flatMap(d => questions.filter(q => q.d === d));
  const counts = [0, 1, 2].map(d => ordered.filter(q => q.d === d).length);

  const body = ordered
    .map((q, i) => `/* ${i + 1} */ {t:${JSON.stringify(q.t)}, d:${q.d}, q:${JSON.stringify(q.q)}, a:${JSON.stringify(q.a)}}`)
    .join(',\n');

  return `const BANK = [
/* ==========================================================
   ${ordered.length} questions — ${counts[0]} easy, ${counts[1]} medium, ${counts[2]} hard
   Auto-generated ${meta.date} via ${meta.provider}
   ========================================================== */

${body}
];`;
}

export function spliceBetween(source, startMarker, endMarker, newInner) {
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker, startIdx);
  if (startIdx === -1 || endIdx === -1) {
    throw new GenerationError(`Could not find markers ${startMarker} / ${endMarker} in index.html`, false);
  }
  const before = source.slice(0, startIdx + startMarker.length);
  const after = source.slice(endIdx);
  return `${before}\n${newInner}\n${after}`;
}

/* ---------- archive ---------- */

const ARCHIVE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

function readArchive(dir) {
  let files;
  try {
    files = readdirSync(dir).filter(f => ARCHIVE_FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
  const sets = [];
  for (const f of files) {
    try {
      sets.push({ date: f.slice(0, 10), questions: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) });
    } catch {
      /* ignore unreadable archive entries */
    }
  }
  return sets;
}

// Keeps the newest ARCHIVE_KEEP sets, by filename date — file mtimes are
// meaningless after a fresh CI checkout.
function pruneArchive(dir) {
  const files = readdirSync(dir).filter(f => ARCHIVE_FILE_RE.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) unlinkSync(path.join(dir, f));
}

/* ---------- main ---------- */

// Returns { status: 'skipped' | 'refreshed', reason } or throws a GenerationError.
export async function main({
  root = DEFAULT_ROOT,
  env = process.env,
  now = new Date(),
  fetchFn = fetch,
  providers = buildProviders(env),
  log = console.log,
  backoffMs = BACKOFF_MS,
  counterRetryMs = 5_000,
  budgetMs = BUDGET_MS,
  minGapMs = MIN_GAP_MS,
} = {}) {
  const indexHtml = path.join(root, 'index.html');
  const archiveDir = path.join(root, 'data', 'questions-archive');
  const lastRunFile = path.join(root, 'data', 'last-run.json');

  const html = readFileSync(indexHtml, 'utf8');
  const setId = readSetId(html);
  if (!setId) throw new GenerationError('Could not find SET_ID in index.html', false);
  const today = istDate(now);
  const force = env.FORCE_REFRESH === 'true';

  let plays = null;
  if (force) {
    log('FORCE_REFRESH=true — generating a new set regardless of activity.');
  } else {
    if (setId >= today) return { status: 'skipped', reason: `current set ${setId} is already today's set` };
    plays = await readPlayCount(setId, fetchFn, counterRetryMs);
    if (plays < 1) return { status: 'skipped', reason: `nobody has answered half of set ${setId} yet` };
    log(`Set ${setId} was played past the halfway mark ${plays} time(s) — generating a new set.`);
  }

  if (!providers.length) throw new GenerationError('No API key configured — set GEMINI_API_KEY or GROQ_API_KEY as a repo secret.', false);

  const recent = readArchive(archiveDir).slice(-RECENT_SETS).flatMap(s => s.questions);
  const seen = new Set(recent.map(q => normalize(q.q)));

  const ctx = { providers, seen, recent, log, backoffMs, minGapMs, deadline: Date.now() + budgetMs };
  const questions = [];
  const usedProviders = new Set();
  for (const [i, batch] of BATCHES.entries()) {
    log(`Batch ${i + 1}/${BATCHES.length}: ${batch.n} × difficulty ${batch.d}, topics ${batch.topics.join(',')}`);
    const res = await fillBatch(batch, ctx);
    questions.push(...res.questions);
    res.providers.forEach(p => usedProviders.add(p));
  }

  const providerLabel = [...usedProviders].join(', ');
  const usedKeys = Object.keys(ALLOWED_TOPICS).filter(k => questions.some(q => q.t === k));
  let updated = spliceBetween(html, SET_START, SET_END, buildSetBlock(today));
  updated = spliceBetween(updated, TOPICS_START, TOPICS_END, buildTopicsBlock(usedKeys));
  updated = spliceBetween(updated, QUESTIONS_START, QUESTIONS_END, buildQuestionsBlock(questions, { date: today, provider: providerLabel }));
  writeFileSync(indexHtml, updated);

  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(path.join(archiveDir, `${today}.json`), JSON.stringify(questions, null, 2));
  pruneArchive(archiveDir);

  const topicCounts = {};
  for (const q of questions) topicCounts[q.t] = (topicCounts[q.t] || 0) + 1;
  writeFileSync(
    lastRunFile,
    JSON.stringify({ date: today, previousSet: setId, plays, provider: providerLabel, status: 'OK', total: questions.length, topicCounts }, null, 2) + '\n'
  );

  return { status: 'refreshed', reason: `new set ${today} (${questions.length} questions via ${providerLabel})` };
}

function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // Transient failures (API overloaded, timeouts, counter unreachable) are
  // retried by the next scheduled slot the same day, so only the last slot —
  // or a manual run — reports them as a failed run.
  const final = process.env.FINAL_ATTEMPT !== 'false';
  main()
    .then(({ status, reason }) => {
      console.log(`::notice::${status === 'skipped' ? 'Skipped' : 'Refreshed'} — ${reason}`);
      summary(`**${status}** — ${reason}`);
    })
    .catch(e => {
      const transient = e.transient !== false;
      console.error(e.stack || e.message);
      summary(`**failed** — ${e.message}`);
      if (transient && !final) {
        console.log(`::warning::Refresh failed (${e.message}) — a later slot today will retry.`);
        return;
      }
      console.log(`::error::Refresh failed: ${e.message}`);
      process.exit(1);
    });
}
