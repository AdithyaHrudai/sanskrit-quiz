#!/usr/bin/env node
// Question-bank refresh for the Sanskrit quiz, run by
// .github/workflows/daily-questions.yml.
//
// The set refreshes at most once per day (IST), and only if it was actually
// played: index.html pings a public Abacus counter (key `set-<SET_ID>`) once a
// visitor has answered at least half of the current set. If nobody has, this
// script exits quietly without calling any LLM or touching the repo.
//
// When a refresh is due, the set is built with as few API calls as possible,
// because the Gemini free tier caps requests per day: one generation call per
// difficulty (each covering every topic, with one spare question per topic) and
// one review call that fact-checks everything at once. Flagged or invalid
// questions are replaced from the spares, so ~4 calls normally suffice.
// index.html is only rewritten once the set is complete, so the live quiz
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

// Questions per difficulty. Split evenly over all topics (3/4/3 each → 10 per topic).
const DIFFICULTY_COUNTS = [30, 40, 30];
export const TOTAL = DIFFICULTY_COUNTS.reduce((a, b) => a + b, 0);
const MIN_TOTAL = 90;              // publish a slightly short set rather than none
const TOPIC_KEYS = Object.keys(ALLOWED_TOPICS);
const GEN_ROUNDS = 3;              // generation calls per difficulty; normally 1 is enough

// Gemini's free tier caps requests per DAY per model (and per minute), so a
// refresh is built to need only ~4 calls: 3 generation + 1 review.
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
    throw new GenerationError(`HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`, res.status >= 500);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GenerationError(`non-JSON API response: ${text.slice(0, 200)}`, true);
  }
}

// Gemini 3+ models are meant to run at their default temperature (lower values
// can degrade their reasoning), so the setting is only sent to older models.
const takesTemperature = model => !/^gemini-(?:[3-9]|\d{2,})/.test(model);

function geminiProvider(model, key) {
  return {
    name: `gemini:${model}`,
    async call(prompt, { temperature }) {
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { 'x-goog-api-key': key },
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { ...(takesTemperature(model) && { temperature }), responseMimeType: 'application/json' },
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

// Each Gemini model has its own free daily quota (20 requests/day/model), so
// a chain of models multiplies the daily budget; a model that is out of quota,
// retired (404) or overloaded is skipped for the rest of the run. GEMINI_MODELS
// (comma-separated, best first) overrides the chain. Groq is a last resort if
// a key is configured.
export const DEFAULT_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];

export function buildProviders(env) {
  const providers = [];
  if (env.GEMINI_API_KEY) {
    const models = (env.GEMINI_MODELS || '').split(',').map(m => m.trim()).filter(Boolean);
    for (const model of [...new Set(models.length ? models : DEFAULT_GEMINI_MODELS)]) {
      providers.push(geminiProvider(model, env.GEMINI_API_KEY));
    }
  }
  if (env.GROQ_API_KEY) providers.push(groqProvider(env.GROQ_MODEL || 'llama-3.3-70b-versatile', env.GROQ_API_KEY));
  return providers;
}

// p.out marks a provider unusable for the rest of the run: 'permanent' (bad
// key, retired model), 'quota' (daily quota spent — fine again tomorrow) or
// 'unavailable' (overloaded / timing out through all its retries).
async function generateText(prompt, ctx, temperature = 0.7) {
  const { providers, log, backoffMs, deadline, minGapMs = MIN_GAP_MS } = ctx;
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
        const text = await p.call(prompt, { temperature });
        ctx.apiCalls++;
        return { text, provider: p.name };
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
    // Out of retries (overloaded / timing out): don't spend the next calls' time on it again.
    if (!p.out && failures >= TRIES_PER_PROVIDER) p.out = 'unavailable';
  }
  const allPermanent = providers.every(p => p.out === 'permanent');
  throw new GenerationError(`all providers failed (last error: ${lastErr?.message ?? 'none configured'})`, !allPermanent);
}

/* ---------- prompting & validation ---------- */

// n questions split as evenly as possible over `keys` (30 over 10 topics → 3 each).
export function splitEvenly(n, keys) {
  const base = Math.floor(n / keys.length);
  const extra = n % keys.length;
  return Object.fromEntries(keys.map((k, i) => [k, base + (i < extra ? 1 : 0)]));
}

const sum = obj => Object.values(obj).reduce((s, v) => s + v, 0);

// needs = { topicKey: howManyStillWanted }. One spare per topic is requested on
// top, so questions lost to validation or review can be replaced without
// another API call (calls are the scarce resource on the free tier).
export function buildPrompt({ d, needs, avoid = [] }) {
  const keys = Object.keys(needs).filter(k => needs[k] > 0);
  const ask = Object.fromEntries(keys.map(k => [k, needs[k] + 1]));
  const topicLines = keys
    .map(k => `  - "${k}" (write exactly ${ask[k]}): ${ALLOWED_TOPICS[k].label} — ${ALLOWED_TOPICS[k].desc}`)
    .join('\n');
  const avoidBlock = avoid.length
    ? `\nThese questions already exist — do not repeat or rephrase any of them:\n${avoid.map(q => `  - ${q}`).join('\n')}\n`
    : '';

  return `You are a Sanskrit quizmaster writing for Sanskrit enthusiasts. Write exactly ${sum(ask)} multiple-choice questions entirely in Sanskrit (Devanagari script only — no English, no transliteration, no Latin letters anywhere).

Difficulty of every question: ${DIFFICULTY[d]}.

Topic keys, with how many questions to write for each:
${topicLines}

Question rules:
  - Every question must be factually accurate and unambiguous — only well-established facts. Do not invent facts.
  - Before answering, re-check every question: the marked answer is certainly right, no other option is also right, and the Sanskrit is correct. Replace any question you are not sure about.
  - Exactly 4 answer options per question, all plausible, all distinct, all in Sanskrit.
  - The FIRST option in "a" must be the correct answer (the app shuffles options before display).
  - No duplicate or near-duplicate questions.
  - No numbering or labels inside the "q" text, and no hint of the answer in it.
${avoidBlock}
Output STRICT JSON only — no markdown fences, no commentary. Shape exactly:
{"questions":[{"t":"${keys[0]}","q":"...","a":["सम्यक् उत्तरम्","अशुद्धम् १","अशुद्धम् २","अशुद्धम् ३"]}]}`;
}

export function checkQuestion(item, topics) {
  if (!item || typeof item !== 'object') return 'not an object';
  const { t, q, a } = item;
  if (!topics.includes(t)) return `topic "${t}" not requested`;
  if (typeof q !== 'string' || !q.trim() || !DEVANAGARI_RE.test(q)) return 'question text missing or not in Devanagari';
  if (LATIN_RE.test(q)) return 'question contains Latin letters';
  if (!Array.isArray(a) || a.length !== 4 || a.some(o => typeof o !== 'string' || !o.trim())) return 'needs exactly 4 non-empty options';
  if (a.some(o => LATIN_RE.test(o)) || !a.some(o => DEVANAGARI_RE.test(o))) return 'options not in Devanagari';
  if (new Set(a.map(o => normalize(o))).size !== 4) return 'options are not distinct';
  return null;
}

// Pulls every complete top-level {...} object out of the questions array of a
// response that isn't valid JSON as a whole — typically one cut off mid-output.
// A truncated reply then still yields its finished questions instead of
// costing us a whole API call.
export function salvageObjects(text) {
  const from = text.indexOf('"questions"');
  const start = text.indexOf('[', Math.max(0, from));
  if (start < 0) return [];
  const out = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) objStart = i; }
    else if (c === '}' && depth > 0) {
      if (--depth === 0) {
        try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* skip malformed object */ }
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) break;
  }
  return out;
}

// Parses one generation response into valid, previously unseen questions.
// `needs` says which topics were requested; `seen` (normalized text) is updated.
export function parseBatch(raw, { d, needs }, seen) {
  const text = stripFences(raw);
  let list;
  let note = null;
  try {
    const parsed = JSON.parse(text);
    list = Array.isArray(parsed) ? parsed : parsed?.questions;
    if (!Array.isArray(list)) return { questions: [], errors: ['"questions" is not an array'] };
  } catch (e) {
    list = salvageObjects(text);
    if (!list.length) return { questions: [], errors: [`response was not valid JSON: ${e.message}`] };
    note = `response was cut off — salvaged ${list.length} complete questions`;
  }

  const topics = Object.keys(needs).filter(k => needs[k] > 0);
  const questions = [];
  const errors = note ? [note] : [];
  for (const [i, item] of list.entries()) {
    const problem = checkQuestion(item, topics);
    if (problem) { errors.push(`#${i}: ${problem}`); continue; }
    const key = normalize(item.q);
    if (seen.has(key)) { errors.push(`#${i}: duplicate`); continue; }
    seen.add(key);
    questions.push({ t: item.t, d, q: item.q.trim(), a: item.a.map(s => s.trim()) });
  }
  return { questions, errors };
}

// Splits candidates into those that fill a still-open slot (`picked`) and the
// rest (`spare`), and returns what is still missing per topic.
export function select(questions, needs) {
  const left = { ...needs };
  const picked = [];
  const spare = [];
  for (const q of questions) {
    if (left[q.t] > 0) { left[q.t]--; picked.push(q); } else spare.push(q);
  }
  return { picked, spare, left };
}

export function buildReviewPrompt(questions) {
  const list = questions
    .map((q, i) => `${i}. ${q.q}\n   claimed correct: ${q.a[0]}\n   other options: ${q.a.slice(1).join(' | ')}`)
    .join('\n');
  return `You are a Sanskrit scholar reviewing quiz questions before publication. For each numbered question below, the "claimed correct" option is presented as the only right answer.

Flag a question only if you are confident that:
  - the claimed correct answer is wrong; or
  - another option is also correct, so the question has no single right answer; or
  - the question is ambiguous or ill-formed enough that a scholar would object; or
  - the question text gives away the answer.
Do not flag a question merely because it is hard, obscure, or you are slightly unsure.

${list}

Output STRICT JSON only: {"bad":[<indices of flagged questions>]}`;
}

// Second-opinion fact check of all candidates in one call. Best-effort: if the
// review call fails, the candidates are kept (reviewed:false) rather than
// throwing away the questions already paid for.
async function reviewQuestions(questions, ctx) {
  if (!questions.length) return { keep: questions, flagged: 0, reviewed: true };
  let text;
  try {
    ({ text } = await generateText(buildReviewPrompt(questions), ctx, 0));
  } catch (e) {
    ctx.log(`  review skipped: ${e.message}`);
    return { keep: questions, flagged: 0, reviewed: false };
  }
  let bad;
  try {
    bad = JSON.parse(stripFences(text)).bad;
  } catch {
    bad = null;
  }
  if (!Array.isArray(bad)) {
    ctx.log('  review skipped: unparseable reviewer response');
    return { keep: questions, flagged: 0, reviewed: false };
  }
  const badSet = new Set(bad.map(Number));
  const keep = questions.filter((_, i) => !badSet.has(i));
  return { keep, flagged: questions.length - keep.length, reviewed: true };
}

// One generation call per difficulty normally (a second only if some topics
// came up short). Returns the questions that fill the slots plus spares.
async function generateFor(d, needs, ctx, maxRounds = GEN_ROUNDS) {
  let left = { ...needs };
  const picked = [];
  const spare = [];
  const avoidBase = ctx.recent.filter(q => q.d === d).map(q => q.q);

  for (let round = 1; round <= maxRounds && sum(left) > 0; round++) {
    const prompt = buildPrompt({ d, needs: left, avoid: [...avoidBase, ...picked.map(q => q.q), ...spare.map(q => q.q)] });
    let text, provider;
    try {
      ({ text, provider } = await generateText(prompt, ctx));
    } catch (e) {
      if (round === 1 && !picked.length) throw e;
      ctx.log(`  difficulty ${d}: giving up on top-up round ${round}: ${e.message}`);
      break;
    }
    ctx.providersUsed.add(provider);
    const { questions, errors } = parseBatch(text, { d, needs: left }, ctx.seen);
    const sel = select(questions, left);
    picked.push(...sel.picked);
    spare.push(...sel.spare);
    left = sel.left;
    ctx.log(`  difficulty ${d} round ${round} via ${provider}: ${picked.length}/${sum(needs)} (+${spare.length} spare)${errors.length ? ` — dropped ${errors.length} (${errors.slice(0, 3).join('; ')})` : ''}`);
  }
  return { picked, spare };
}

// Fills difficulty d's slots from reviewed questions: the picks first, then
// spares of the same topic, then spares of any topic. Returns the final list
// and how many slots are still empty.
export function fillFrom(goodPicked, goodSpare, needs, target) {
  const final = [...goodPicked];
  const spare = [...goodSpare];
  const have = {};
  for (const q of final) have[q.t] = (have[q.t] || 0) + 1;
  for (const k of Object.keys(needs)) {
    while ((have[k] || 0) < needs[k]) {
      const i = spare.findIndex(q => q.t === k);
      if (i < 0) break;
      final.push(...spare.splice(i, 1));
      have[k] = (have[k] || 0) + 1;
    }
  }
  while (final.length < target && spare.length) final.push(spare.shift());
  return { final, missing: Math.max(0, target - final.length) };
}

// Topic needs for `missing` extra questions: always the least-covered topics.
export function topUpNeeds(final, missing) {
  const have = Object.fromEntries(TOPIC_KEYS.map(k => [k, 0]));
  for (const q of final) have[q.t]++;
  const needs = Object.fromEntries(TOPIC_KEYS.map(k => [k, 0]));
  for (let i = 0; i < missing; i++) {
    const k = TOPIC_KEYS.reduce((a, b) => (have[a] + needs[a] <= have[b] + needs[b] ? a : b));
    needs[k]++;
  }
  return needs;
}

// Builds the whole set: 3 generation calls + 1 review call, plus (only if
// reviewed-out questions couldn't be covered by spares) up to 3 small top-up
// calls and 1 more review call.
export async function buildSet(ctx) {
  const plan = DIFFICULTY_COUNTS.map((n, d) => ({ d, n, needs: splitEvenly(n, TOPIC_KEYS) }));

  const gen = [];
  for (const p of plan) {
    ctx.log(`Generating ${p.n} × difficulty ${p.d}`);
    gen.push(await generateFor(p.d, p.needs, ctx));
  }

  const cands = gen.flatMap((g, i) => [
    ...g.picked.map(q => ({ q, d: i, spare: false })),
    ...g.spare.map(q => ({ q, d: i, spare: true })),
  ]);
  ctx.log(`Reviewing ${cands.length} candidates`);
  const review = await reviewQuestions(cands.map(c => c.q), ctx);
  ctx.reviewed = review.reviewed;
  const kept = new Set(review.keep);
  ctx.log(`  review flagged ${review.flagged}`);

  const finals = plan.map(p => {
    const mine = cands.filter(c => c.d === p.d && kept.has(c.q));
    return fillFrom(mine.filter(c => !c.spare).map(c => c.q), mine.filter(c => c.spare).map(c => c.q), p.needs, p.n);
  });

  // Rare: spares didn't cover everything the reviewer rejected.
  const gaps = finals.map((f, d) => ({ d, missing: f.missing })).filter(g => g.missing > 0);
  if (gaps.length) {
    ctx.log(`Topping up ${gaps.map(g => `${g.missing} × difficulty ${g.d}`).join(', ')}`);
    const fresh = [];
    for (const g of gaps) {
      try {
        const res = await generateFor(g.d, topUpNeeds(finals[g.d].final, g.missing), ctx, 2);
        fresh.push(...res.picked, ...res.spare);
      } catch (e) {
        ctx.log(`  top-up for difficulty ${g.d} failed: ${e.message}`);
      }
    }
    const { keep } = await reviewQuestions(fresh, ctx);
    for (const g of gaps) {
      const add = keep.filter(q => q.d === g.d).slice(0, g.missing);
      finals[g.d].final.push(...add);
      finals[g.d].missing -= add.length;
    }
  }

  return finals.flatMap(f => f.final);
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

  const ctx = {
    providers, seen, recent, log, backoffMs, minGapMs,
    deadline: Date.now() + budgetMs,
    providersUsed: new Set(),
    apiCalls: 0,
    reviewed: true,
  };
  const questions = await buildSet(ctx);
  if (questions.length < MIN_TOTAL) {
    throw new GenerationError(`only ${questions.length} usable questions after review (need at least ${MIN_TOTAL})`, true);
  }

  const providerLabel = [...ctx.providersUsed].join(', ');
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
    JSON.stringify({
      date: today, previousSet: setId, plays, provider: providerLabel,
      apiCalls: ctx.apiCalls, reviewed: ctx.reviewed,
      status: 'OK', total: questions.length, topicCounts,
    }, null, 2) + '\n'
  );

  return { status: 'refreshed', reason: `new set ${today} (${questions.length} questions via ${providerLabel}, ${ctx.apiCalls} API calls${ctx.reviewed ? '' : ', NOT reviewed'})` };
}

function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/* ---------- failure reporting ---------- */

// A failed run is the only thing that makes GitHub send an email, so it is
// reserved for problems that need a human:
//   - anything that isn't a plain API hiccup (bad key, broken markers, a bug);
//   - a manual run (someone is watching);
//   - a refresh that has stayed undone for STALE_DAYS mornings, and only from
//     the last slot of the day.
// Ordinary flakiness (overloaded API, rate limits, timeouts) just logs a
// warning: the next slot — or tomorrow's — retries on its own, and the live
// quiz keeps serving the current set meanwhile.
export const STALE_DAYS = 3;

export function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

export function shouldFail(err, { manual, final, setId, today }) {
  const transient = err instanceof GenerationError && err.transient === true;
  if (!transient || manual) return true;
  return final && setId != null && daysBetween(setId, today) >= STALE_DAYS;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main()
    .then(({ status, reason }) => {
      console.log(`::notice::${status === 'skipped' ? 'Skipped' : 'Refreshed'} — ${reason}`);
      summary(`**${status}** — ${reason}`);
    })
    .catch(e => {
      console.error(e.stack || e.message);
      summary(`**failed** — ${e.message}`);
      let setId = null;
      try { setId = readSetId(readFileSync(path.join(DEFAULT_ROOT, 'index.html'), 'utf8')); } catch { /* reported as a hard failure below */ }
      const today = istDate();
      const fail = shouldFail(e, {
        manual: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
        final: process.env.FINAL_ATTEMPT === 'true',
        setId,
        today,
      });
      if (!fail) {
        console.log(`::warning::Refresh failed (${e.message}) — will retry at the next scheduled run.`);
        return;
      }
      console.log(`::error::Refresh failed: ${e.message}`);
      process.exit(1);
    });
}
