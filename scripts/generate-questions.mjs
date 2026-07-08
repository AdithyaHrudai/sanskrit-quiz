#!/usr/bin/env node
// Daily question-bank refresh for the Sanskrit quiz.
// Calls a free LLM API (Groq or Gemini — whichever secret is set), asks for
// 100 validated Sanskrit MCQs, and rewrites the AUTO-GENERATED block in
// index.html. Never touches index.html if generation/validation fails, so
// the live quiz always keeps serving the last known-good question set.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const ARCHIVE_DIR = path.join(REPO_ROOT, 'data', 'questions-archive');
const LAST_RUN_FILE = path.join(REPO_ROOT, 'data', 'last-run.json');

const TOPICS_START = '/* AUTO-GENERATED:TOPICS:START — overwritten daily by scripts/generate-questions.mjs, do not hand-edit */';
const TOPICS_END = '/* AUTO-GENERATED:TOPICS:END */';
const QUESTIONS_START = '/* AUTO-GENERATED:QUESTIONS:START — overwritten daily by scripts/generate-questions.mjs, do not hand-edit */';
const QUESTIONS_END = '/* AUTO-GENERATED:QUESTIONS:END */';

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

const EASY_COUNT = 30;
const MEDIUM_COUNT = 40;
const HARD_COUNT = 30;
const TOTAL = EASY_COUNT + MEDIUM_COUNT + HARD_COUNT;
const MAX_RETRIES = 4;
const DEVANAGARI_RE = /[ऀ-ॿ]/;

function todayStr() {
  const iso = process.env.RUN_DATE || new Date().toISOString();
  return iso.slice(0, 10);
}

function buildPrompt() {
  const topicLines = Object.entries(ALLOWED_TOPICS)
    .map(([key, t]) => `  - "${key}": ${t.label} — ${t.desc}`)
    .join('\n');

  return `You are a Sanskrit quizmaster. Generate exactly ${TOTAL} multiple-choice questions (MCQs) entirely in Sanskrit (Devanagari script only — no English, no transliteration).

Allowed topic keys (use ONLY these, spread reasonably evenly across as many of them as fit naturally — do not force every topic if it does not fit):
${topicLines}

Difficulty rules:
  - Exactly ${EASY_COUNT} questions with "d": 0 (easy)
  - Exactly ${MEDIUM_COUNT} questions with "d": 1 (medium)
  - Exactly ${HARD_COUNT} questions with "d": 2 (hard)

Question rules:
  - Every question must be factually accurate and unambiguous — only well-established facts (grammar rules, mythology, geography, history, capitals, vocabulary, literature). Do not invent facts.
  - Each question needs exactly 4 answer options, all plausible, all in Sanskrit.
  - The FIRST option in the "a" array must always be the correct answer (options get shuffled by the app before display, so ordering here doesn't matter for the user, but a[0] must be correct).
  - No duplicate or near-duplicate questions.
  - No question numbering or labels inside the "q" text.
  - Do not reveal or hint at the answer inside the question text.

Output STRICT JSON only — no markdown fences, no commentary, no trailing text. Shape exactly:
{"questions":[{"t":"vy","d":0,"q":"...","a":["सम्यक् उत्तरम्","अशुद्धम् १","अशुद्धम् २","अशुद्धम् ३"]}, ... exactly ${TOTAL} objects total]}`;
}

export function stripFences(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
  }
  return t.trim();
}

async function callGroq(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Groq API error ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, responseMimeType: 'application/json' },
        }),
        signal: controller.signal,
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
    return data.candidates[0].content.parts[0].text;
  } finally {
    clearTimeout(timeout);
  }
}

function pickProvider() {
  if (process.env.GROQ_API_KEY) return { name: 'groq', call: callGroq };
  if (process.env.GEMINI_API_KEY) return { name: 'gemini', call: callGemini };
  throw new Error('No API key configured — set GROQ_API_KEY or GEMINI_API_KEY as a repo secret.');
}

export function validate(raw) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (e) {
    return { ok: false, errors: [`Response was not valid JSON: ${e.message}`] };
  }

  const questions = parsed?.questions;
  if (!Array.isArray(questions)) {
    return { ok: false, errors: ['"questions" is not an array'] };
  }
  if (questions.length !== TOTAL) {
    errors.push(`Expected ${TOTAL} questions, got ${questions.length}`);
  }

  const seenText = new Set();
  let easy = 0, medium = 0, hard = 0;
  const clean = [];

  questions.forEach((item, i) => {
    const where = `question[${i}]`;
    if (!item || typeof item !== 'object') { errors.push(`${where}: not an object`); return; }
    const { t, d, q, a } = item;

    if (!ALLOWED_TOPICS[t]) { errors.push(`${where}: unknown topic "${t}"`); return; }
    if (![0, 1, 2].includes(d)) { errors.push(`${where}: invalid difficulty "${d}"`); return; }
    if (typeof q !== 'string' || !q.trim() || !DEVANAGARI_RE.test(q)) {
      errors.push(`${where}: question text missing or not in Devanagari`); return;
    }
    if (!Array.isArray(a) || a.length !== 4 || a.some(opt => typeof opt !== 'string' || !opt.trim())) {
      errors.push(`${where}: needs exactly 4 non-empty answer strings`); return;
    }
    if (!a.some(opt => DEVANAGARI_RE.test(opt))) {
      errors.push(`${where}: answers not in Devanagari`); return;
    }
    const key = q.trim();
    if (seenText.has(key)) { errors.push(`${where}: duplicate question`); return; }
    seenText.add(key);

    if (d === 0) easy++; else if (d === 1) medium++; else hard++;
    clean.push({ t, d, q: q.trim(), a: a.map(s => s.trim()) });
  });

  if (easy !== EASY_COUNT) errors.push(`Expected ${EASY_COUNT} easy questions, got ${easy}`);
  if (medium !== MEDIUM_COUNT) errors.push(`Expected ${MEDIUM_COUNT} medium questions, got ${medium}`);
  if (hard !== HARD_COUNT) errors.push(`Expected ${HARD_COUNT} hard questions, got ${hard}`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, questions: clean };
}

export function buildTopicsBlock(usedKeys) {
  const lines = usedKeys.map(k => `  ${k}: '${ALLOWED_TOPICS[k].label}'`).join(',\n');
  return `const T = {\n${lines}\n};`;
}

export function buildQuestionsBlock(questions, meta) {
  const byDiff = { 0: [], 1: [], 2: [] };
  for (const q of questions) byDiff[q.d].push(q);
  const ordered = [...byDiff[0], ...byDiff[1], ...byDiff[2]];

  const body = ordered
    .map((q, i) => `/* ${i + 1} */ {t:${JSON.stringify(q.t)}, d:${q.d}, q:${JSON.stringify(q.q)}, a:${JSON.stringify(q.a)}}`)
    .join(',\n');

  return `const BANK = [
/* ==========================================================
   ${TOTAL} questions — ${EASY_COUNT} easy, ${MEDIUM_COUNT} medium, ${HARD_COUNT} hard
   Auto-generated ${meta.date} via ${meta.provider}
   ========================================================== */

${body}
];`;
}

export function spliceBetween(source, startMarker, endMarker, newInner) {
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker, startIdx);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Could not find markers ${startMarker} / ${endMarker} in index.html`);
  }
  const before = source.slice(0, startIdx + startMarker.length);
  const after = source.slice(endIdx);
  return `${before}\n${newInner}\n${after}`;
}

function pruneOldArchives(days = 30) {
  let files;
  try {
    files = readdirSync(ARCHIVE_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const f of files) {
    const full = path.join(ARCHIVE_DIR, f);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}

export async function main() {
  const provider = pickProvider();
  const date = todayStr();
  const prompt = buildPrompt();

  let result = null;
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[${provider.name}] attempt ${attempt}/${MAX_RETRIES}...`);
    let raw;
    try {
      raw = await provider.call(prompt);
    } catch (e) {
      attempts.push({ attempt, error: `API call failed: ${e.message}` });
      console.error(attempts[attempts.length - 1].error);
      continue;
    }
    const validation = validate(raw);
    if (validation.ok) {
      result = validation.questions;
      break;
    }
    attempts.push({ attempt, errors: validation.errors });
    console.error(`Validation failed:\n  - ${validation.errors.slice(0, 10).join('\n  - ')}`);
  }

  mkdirSync(path.dirname(LAST_RUN_FILE), { recursive: true });

  if (!result) {
    const summary = { date, provider: provider.name, status: 'FAILED', attempts };
    writeFileSync(LAST_RUN_FILE, JSON.stringify(summary, null, 2));
    console.error(`All ${MAX_RETRIES} attempts failed — leaving index.html untouched.`);
    process.exit(1);
  }

  const usedKeys = Object.keys(ALLOWED_TOPICS).filter(k => result.some(q => q.t === k));
  const html = readFileSync(INDEX_HTML, 'utf8');

  let updated = spliceBetween(html, TOPICS_START, TOPICS_END, buildTopicsBlock(usedKeys));
  updated = spliceBetween(updated, QUESTIONS_START, QUESTIONS_END, buildQuestionsBlock(result, { date, provider: provider.name }));

  writeFileSync(INDEX_HTML, updated);

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(path.join(ARCHIVE_DIR, `${date}.json`), JSON.stringify(result, null, 2));
  pruneOldArchives();

  const topicCounts = {};
  for (const q of result) topicCounts[q.t] = (topicCounts[q.t] || 0) + 1;
  writeFileSync(
    LAST_RUN_FILE,
    JSON.stringify({ date, provider: provider.name, status: 'OK', total: result.length, topicCounts }, null, 2)
  );

  console.log(`Done. Wrote ${result.length} questions across topics: ${usedKeys.join(', ')}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(e => {
    console.error('Unexpected failure:', e);
    process.exit(1);
  });
}
