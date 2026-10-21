// Offline checks for scripts/generate-questions.mjs — no API keys or network.
// Run: node scripts/test-dryrun.mjs
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  ALLOWED_TOPICS, TOTAL, COUNTER_NS, DEFAULT_GEMINI_MODELS, GenerationError, istDate, readSetId, stripFences,
  splitEvenly, buildPrompt, buildReviewPrompt, checkQuestion, salvageObjects, parseBatch, select, fillFrom, topUpNeeds,
  buildProviders, rateLimitError, daysBetween, shouldFail, main,
} from './generate-questions.mjs';

const realHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const TOPICS = Object.keys(ALLOWED_TOPICS);

// --- helpers ---
assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
assert.equal(istDate(new Date('2026-10-20T18:29:00Z')), '2026-10-20');
assert.equal(istDate(new Date('2026-10-20T18:31:00Z')), '2026-10-21', 'IST rolls over at 18:30 UTC');
assert.match(readSetId(realHtml), /^\d{4}-\d{2}-\d{2}$/);
assert.ok(realHtml.includes(`const COUNTER_NS = '${COUNTER_NS}';`), 'index.html and script must share COUNTER_NS');
assert.equal(TOTAL, 100);
assert.deepEqual(splitEvenly(30, TOPICS), Object.fromEntries(TOPICS.map(k => [k, 3])));
assert.deepEqual(Object.values(splitEvenly(43, TOPICS)).reduce((a, b) => a + b, 0), 43);
console.log('helpers: OK');

// --- failure reporting: when is a failed (= emailed) run warranted? ---
{
  const hiccup = new GenerationError('HTTP 503', true);
  const hard = new GenerationError('bad key', false);
  const base = { manual: false, final: true, setId: '2026-10-20', today: '2026-10-21' };
  assert.equal(daysBetween('2026-10-30', '2026-11-02'), 3, 'month boundary');
  assert.equal(shouldFail(hiccup, base), false, 'API hiccup, set only 1 day old: warn only');
  assert.equal(shouldFail(hiccup, { ...base, today: '2026-10-22' }), false, '2 days: still warn only');
  assert.equal(shouldFail(hiccup, { ...base, today: '2026-10-23' }), true, '3 mornings stale on the last slot: report');
  assert.equal(shouldFail(hiccup, { ...base, today: '2026-10-25', final: false }), false, 'never from a non-final slot');
  assert.equal(shouldFail(hard, { ...base, final: false }), true, 'permanent errors always report');
  assert.equal(shouldFail(new TypeError('bug'), base), true, 'unexpected exceptions always report');
  assert.equal(shouldFail(hiccup, { ...base, manual: true }), true, 'manual runs always report');
  assert.equal(shouldFail(hiccup, { ...base, setId: null, today: '2026-10-25' }), false, 'unknown set id never counts as stale');
}
console.log('shouldFail(): OK');

// --- 429 parsing (shape of a real Gemini free-tier response) ---
{
  const body = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota ... Please retry in 37.5s.', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
  ] } });
  const e = rateLimitError(body, null);
  assert.equal(e.rateLimited, true);
  assert.equal(e.daily, false);
  assert.equal(e.retryAfterMs, 37_000);
  assert.match(e.message, /PerMinute.*retry in 37s/);
  assert.equal(rateLimitError(body.replace('PerMinute', 'PerDay'), null).daily, true);
  assert.equal(rateLimitError('not json', '12').retryAfterMs, 12_000, 'falls back to Retry-After header');
}
console.log('rateLimitError(): OK');

// --- providers ---
{
  assert.deepEqual(buildProviders({ GEMINI_API_KEY: 'k' }).map(p => p.name), DEFAULT_GEMINI_MODELS.map(m => `gemini:${m}`));
  assert.deepEqual(buildProviders({ GEMINI_API_KEY: 'k', GEMINI_MODELS: ' a , b,a ' }).map(p => p.name), ['gemini:a', 'gemini:b']);
  assert.deepEqual(buildProviders({ GROQ_API_KEY: 'g' }).map(p => p.name), ['groq:llama-3.3-70b-versatile']);
  assert.deepEqual(buildProviders({}), []);
}
console.log('buildProviders(): OK');

// --- per-question validation ---
const good = { t: 'vy', q: 'रामस्य पिता कः ?', a: ['दशरथः', 'जनकः', 'वसिष्ठः', 'विश्वामित्रः'] };
assert.equal(checkQuestion(good, ['vy']), null);
assert.match(checkQuestion({ ...good, t: 'rc' }, ['vy']), /not requested/);
assert.match(checkQuestion({ ...good, q: 'Who is Rama?' }, ['vy']), /Devanagari/);
assert.match(checkQuestion({ ...good, q: 'रामस्य father कः ?' }, ['vy']), /Latin/);
assert.match(checkQuestion({ ...good, a: good.a.slice(0, 3) }, ['vy']), /4/);
assert.match(checkQuestion({ ...good, a: ['दशरथः', 'दशरथः ।', 'जनकः', 'वसिष्ठः'] }, ['vy']), /distinct/);
console.log('checkQuestion(): OK');

// --- truncated / malformed responses still yield their complete questions ---
{
  const full = JSON.stringify({ questions: [good, { ...good, q: 'सीतायाः पिता कः ?' }, { ...good, q: 'लक्ष्मणस्य माता का ?' }] });
  const cut = full.slice(0, full.lastIndexOf('{') + 25); // dies in the middle of the third object
  assert.throws(() => JSON.parse(cut));
  assert.equal(salvageObjects(cut).length, 2);
  assert.equal(salvageObjects('{"questions":[{"q":"a } b \\" {","a":[]}, {"q":"x"').length, 1, 'braces/quotes inside strings are respected');
  assert.equal(salvageObjects('garbage').length, 0);
  const { questions, errors } = parseBatch(cut, { d: 0, needs: { vy: 5 } }, new Set());
  assert.equal(questions.length, 2);
  assert.ok(errors.some(e => e.includes('cut off')));
}
console.log('salvageObjects(): OK');

// --- tolerant batch parsing: drops bad / duplicate items ---
{
  const seen = new Set();
  const items = [good, { ...good, q: 'What?' }, { ...good }, { ...good, q: 'सीतायाः पिता कः ?' }, { ...good, t: 'rc', q: 'अन्यः प्रश्नः कः ?' }];
  const { questions, errors } = parseBatch('```json\n' + JSON.stringify({ questions: items }) + '\n```', { d: 1, needs: { vy: 3, pu: 0 } }, seen);
  assert.equal(questions.length, 2);
  assert.ok(questions.every(q => q.d === 1));
  assert.ok(['duplicate', 'Devanagari', 'not requested'].every(w => errors.some(e => e.includes(w))));
  assert.equal(parseBatch('not json', { d: 0, needs: { vy: 1 } }, new Set()).questions.length, 0);
}
console.log('parseBatch(): OK');

// --- slot selection and gap filling ---
{
  const mk = (t, n) => Array.from({ length: n }, (_, i) => ({ t, d: 0, q: `${t}${i}`, a: ['1', '2', '3', '4'] }));
  const sel = select([...mk('vy', 4), ...mk('pu', 1)], { vy: 3, pu: 3 });
  assert.equal(sel.picked.length, 4);
  assert.equal(sel.spare.length, 1);
  assert.deepEqual(sel.left, { vy: 0, pu: 2 });

  // 2 'vy' lost in review: covered by same-topic spares first, then any-topic spares
  const r1 = fillFrom(mk('vy', 1).concat(mk('pu', 3)), [...mk('vy', 1).map(q => ({ ...q, q: 'vyS' })), ...mk('su', 2)], { vy: 3, pu: 3 }, 6);
  assert.equal(r1.final.length, 6);
  assert.equal(r1.missing, 0);
  assert.equal(r1.final.filter(q => q.t === 'vy').length, 2, 'only one same-topic spare existed');
  assert.equal(fillFrom(mk('vy', 1), [], { vy: 3 }, 3).missing, 2);

  const needs = topUpNeeds([...mk('vy', 5), ...mk('pu', 5)], 3);
  assert.equal(Object.values(needs).reduce((a, b) => a + b, 0), 3);
  assert.equal(needs.vy + needs.pu, 0, 'top-ups go to the least-covered topics');
}
console.log('select()/fillFrom()/topUpNeeds(): OK');

// --- prompts ---
{
  const p = buildPrompt({ d: 1, needs: { vy: 4, pu: 4, de: 0 }, avoid: ['पूर्वप्रश्नः ?'] });
  assert.ok(p.includes('(write exactly 5): ' + ALLOWED_TOPICS.vy.label), 'one spare is requested per topic');
  assert.ok(p.includes('Write exactly 10 multiple-choice'));
  assert.ok(!p.includes('"de"'), 'topics with no remaining need are not requested');
  assert.ok(p.includes('पूर्वप्रश्नः ?'));
  assert.ok(buildReviewPrompt([{ ...good, d: 0 }]).includes('claimed correct: दशरथः'));
}
console.log('prompts: OK');

// --- end-to-end against a temp copy of the repo ---
const DV = '०१२३४५६७८९';
const dv = n => String(n).replace(/\d/g, d => DV[d]);
let qCounter = 0;

// Mock LLM. Generation prompts get unique valid questions per topic (exactly as
// many as asked) plus one junk item; review prompts flag the first `flagFirst`
// questions on the first review call only.
function mockProvider(name, { failWith, flagFirst = 0, truncate = false } = {}) {
  let reviewCalls = 0;
  return {
    name,
    calls: 0,
    prompts: [],
    async call(prompt) {
      this.calls++;
      this.prompts.push(prompt);
      if (failWith) throw failWith;
      if (prompt.includes('scholar reviewing quiz questions')) {
        const n = (prompt.match(/^\d+\. /gm) || []).length;
        return JSON.stringify({ bad: reviewCalls++ === 0 ? Array.from({ length: Math.min(flagFirst, n) }, (_, i) => i) : [] });
      }
      const questions = [];
      for (const m of prompt.matchAll(/^ {2}- "(\w\w)" \(write exactly (\d+)\)/gm)) {
        for (let i = 0; i < Number(m[2]); i++) {
          const k = qCounter++;
          questions.push({ t: m[1], q: `परीक्षाप्रश्नः ${dv(k)} किम् ?`, a: [`उत्तरम् ${dv(k)}क`, `उत्तरम् ${dv(k)}ख`, `उत्तरम् ${dv(k)}ग`, `उत्तरम् ${dv(k)}घ`] });
        }
      }
      questions.push({ t: questions[0].t, q: 'English junk', a: ['a', 'b', 'c', 'd'] });
      const json = JSON.stringify({ questions });
      return truncate ? json.slice(0, json.length - 40) : json;
    },
  };
}

function tempRepo(setId) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sq-test-'));
  writeFileSync(path.join(dir, 'index.html'), realHtml.replace(/const SET_ID = '[^']*';/, `const SET_ID = '${setId}';`));
  mkdirSync(path.join(dir, 'data', 'questions-archive'), { recursive: true });
  // 31 archived sets so pruning has something to do
  for (let i = 1; i <= 31; i++) {
    const date = `2026-08-${String(i).padStart(2, '0')}`;
    writeFileSync(path.join(dir, 'data', 'questions-archive', `${date}.json`), JSON.stringify([{ t: 'vy', d: 0, q: `पुरातनः ${dv(i)} ?`, a: ['क', 'ख', 'ग', 'घ'] }]));
  }
  return dir;
}

const counter = value => async url => {
  assert.ok(url.includes(`/get/${COUNTER_NS}/set-`), `unexpected counter URL ${url}`);
  if (value === 'down') throw new TypeError('fetch failed');
  return value === null
    ? { ok: false, status: 404, json: async () => ({ error: 'Key not found' }) }
    : { ok: true, status: 200, json: async () => ({ value }) };
};

const NOW = new Date('2026-10-22T03:00:00Z'); // 08:30 IST on 2026-10-22
const quiet = () => {};
const opts = extra => ({ env: {}, now: NOW, log: quiet, backoffMs: [0], counterRetryMs: 0, minGapMs: 0, ...extra });

function limited({ daily = false } = {}) {
  const e = new GenerationError('HTTP 429', true);
  Object.assign(e, { rateLimited: true, daily, retryAfterMs: 0 });
  return e;
}

const loadBank = html => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(script); // syntax check only
  return new Function(script.slice(0, script.indexOf('/* ---------- refresh signal')) + 'return BANK;')();
};

// skip: set is already today's
{
  const dir = tempRepo('2026-10-22');
  const p = mockProvider('mock');
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(5) }));
  assert.equal(r.status, 'skipped');
  assert.equal(p.calls, 0);
  rmSync(dir, { recursive: true });
}
// skip: nobody reached the halfway mark (counter key never created → 404)
{
  const dir = tempRepo('2026-10-20');
  const p = mockProvider('mock');
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(null) }));
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /nobody/);
  assert.equal(p.calls, 0, 'no LLM calls when nobody played');
  assert.ok(readFileSync(path.join(dir, 'index.html'), 'utf8').includes("const SET_ID = '2026-10-20';"));
  rmSync(dir, { recursive: true });
}
// counter unreachable → transient error (retried by a later slot)
{
  const dir = tempRepo('2026-10-20');
  await assert.rejects(main(opts({ root: dir, providers: [mockProvider('mock')], fetchFn: counter('down') })), e => e.transient === true);
  rmSync(dir, { recursive: true });
}
console.log('main() skip paths: OK');

// happy path: exactly 4 API calls (3 generation + 1 review), balanced set
{
  const dir = tempRepo('2026-10-20');
  const p = mockProvider('ok');
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(2) }));
  assert.equal(r.status, 'refreshed', r.reason);
  assert.equal(p.calls, 4, 'API calls are the scarce resource: 3 generation + 1 review');

  const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.equal(readSetId(html), '2026-10-22');
  const bank = loadBank(html);
  assert.equal(bank.length, 100);
  assert.deepEqual([0, 1, 2].map(d => bank.filter(q => q.d === d).length), [30, 40, 30]);
  assert.ok(TOPICS.every(k => bank.filter(q => q.t === k).length === 10), 'every topic has exactly 10 questions');
  assert.equal(new Set(bank.map(q => q.q)).size, 100);
  assert.ok(!bank.some(q => q.q === 'English junk'));
  assert.ok(!realHtml.includes('परीक्षाप्रश्नः') && html.includes('परीक्षाप्रश्नः'));

  // the avoid list shows recent archived easy questions (last 10 sets only), per difficulty
  const easy = p.prompts.find(x => x.includes('Difficulty of every question: easy'));
  assert.ok(easy.includes('पुरातनः ३१ ?') && easy.includes('पुरातनः २२ ?'), 'recent sets go in the avoid list');
  assert.ok(!easy.includes('पुरातनः २१ ?'), 'older sets are not');
  assert.ok(!p.prompts.find(x => x.includes('Difficulty of every question: hard')).includes('पुरातनः'), 'avoid list is per difficulty');

  const archive = readdirSync(path.join(dir, 'data', 'questions-archive'));
  assert.equal(archive.length, 30, 'archive pruned to newest 30');
  assert.ok(archive.includes('2026-10-22.json') && !archive.includes('2026-08-01.json'));
  const last = JSON.parse(readFileSync(path.join(dir, 'data', 'last-run.json'), 'utf8'));
  assert.deepEqual([last.previousSet, last.plays, last.apiCalls, last.reviewed], ['2026-10-20', 2, 4, true]);
  rmSync(dir, { recursive: true });
}
console.log('main() happy path (4 calls, balanced set): OK');

// reviewer rejects 8 questions: spares cover them, still 4 calls
{
  const dir = tempRepo('2026-10-20');
  const p = mockProvider('ok', { flagFirst: 8 });
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.equal(p.calls, 4, 'spares absorb review rejections without extra calls');
  assert.equal(loadBank(readFileSync(path.join(dir, 'index.html'), 'utf8')).length, 100);
  rmSync(dir, { recursive: true });
}
// reviewer rejects more than the spares can cover (12 easy ones; only 10 spares): a small top-up fills the gap
{
  const dir = tempRepo('2026-10-20');
  const p = mockProvider('ok', { flagFirst: 12 });
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.ok(p.calls > 4 && p.calls <= 7, `top-up used ${p.calls} calls`);
  assert.equal(loadBank(readFileSync(path.join(dir, 'index.html'), 'utf8')).length, 100);
  rmSync(dir, { recursive: true });
}
// reviewer rejects a huge share of everything: the run still finishes within a sane call budget
{
  const dir = tempRepo('2026-10-20');
  const p = mockProvider('ok', { flagFirst: 70 });
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.ok(p.calls > 4 && p.calls <= 10, `top-ups used ${p.calls} calls`);
  const bank = loadBank(readFileSync(path.join(dir, 'index.html'), 'utf8'));
  assert.ok(bank.length >= 90, `got ${bank.length}`);
  rmSync(dir, { recursive: true });
}
// truncated responses: complete questions are salvaged, gaps topped up
{
  const dir = tempRepo('2026-10-20');
  const p = mockProvider('ok', { truncate: true });
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.ok(loadBank(readFileSync(path.join(dir, 'index.html'), 'utf8')).length >= 90);
  rmSync(dir, { recursive: true });
}
// review call itself fails: the set is still published, marked unreviewed
{
  const dir = tempRepo('2026-10-20');
  const p = mockProvider('ok');
  const inner = p.call;
  p.call = async function (prompt) {
    if (prompt.includes('scholar reviewing')) throw new GenerationError('HTTP 400', false);
    return inner.call(this, prompt);
  };
  const r = await main(opts({ root: dir, providers: [p], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.match(r.reason, /NOT reviewed/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'data', 'last-run.json'), 'utf8')).reviewed, false);
  rmSync(dir, { recursive: true });
}
console.log('main() review edge cases: OK');

// provider chain: overloaded (503), retired model (404), then a working one
{
  const dir = tempRepo('2026-10-20');
  const overloaded = mockProvider('overloaded', { failWith: new GenerationError('HTTP 503', true) });
  const gone = mockProvider('gone', { failWith: new GenerationError('HTTP 404', false) });
  const ok = mockProvider('ok');
  const r = await main(opts({ root: dir, providers: [overloaded, gone, ok], fetchFn: counter(2) }));
  assert.equal(r.status, 'refreshed', r.reason);
  assert.equal(gone.calls, 1, 'a retired model is tried once, then skipped for the rest of the run');
  assert.equal(overloaded.calls, 3, 'an overloaded model is retried 3 times on the first call, then skipped');
  rmSync(dir, { recursive: true });
}
// the review goes to a different model than the one that generated, when there is one
{
  const dir = tempRepo('2026-10-20');
  const writer = mockProvider('writer');
  const checker = mockProvider('checker');
  const r = await main(opts({ root: dir, providers: [writer, checker], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.equal(writer.calls, 3, 'the first model writes all three difficulties');
  assert.equal(checker.calls, 1, 'an independent model does the review');
  assert.ok(checker.prompts[0].includes('scholar reviewing'));
  rmSync(dir, { recursive: true });
}
// ...and the same model reviews when it is the only one left
{
  const dir = tempRepo('2026-10-20');
  const only = mockProvider('only');
  await main(opts({ root: dir, providers: [only], fetchFn: counter(1) }));
  assert.equal(only.calls, 4);
  rmSync(dir, { recursive: true });
}
// per-minute 429s: wait and retry the same model rather than falling back
{
  const dir = tempRepo('2026-10-20');
  const primary = mockProvider('primary');
  const inner = primary.call;
  let n = 0;
  primary.call = async function (prompt) {
    if (n++ % 3 === 0) { this.calls++; throw limited(); } // every third call rate-limited
    return inner.call(this, prompt);
  };
  const fallback = mockProvider('fallback');
  const r = await main(opts({ root: dir, providers: [primary, fallback], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.ok(fallback.prompts.every(p => p.includes('scholar reviewing')), 'per-minute rate limits never push generation to the fallback model');
  rmSync(dir, { recursive: true });
}
// daily quota spent on the first model → moves straight to the next one
{
  const dir = tempRepo('2026-10-20');
  const spent = mockProvider('spent', { failWith: limited({ daily: true }) });
  const next = mockProvider('next');
  const r = await main(opts({ root: dir, providers: [spent, next], fetchFn: counter(1) }));
  assert.equal(r.status, 'refreshed');
  assert.equal(spent.calls, 1, 'a model out of daily quota is not retried');
  rmSync(dir, { recursive: true });
}
// daily quota spent on every model → transient (a later slot / tomorrow retries), index.html untouched
{
  const dir = tempRepo('2026-10-20');
  const before = readFileSync(path.join(dir, 'index.html'), 'utf8');
  await assert.rejects(main(opts({ root: dir, providers: [mockProvider('x', { failWith: limited({ daily: true }) })], fetchFn: counter(1) })), e => e.transient === true);
  assert.equal(readFileSync(path.join(dir, 'index.html'), 'utf8'), before);
  rmSync(dir, { recursive: true });
}
console.log('main() provider chain + quota handling: OK');

// every provider has a bad key → permanent (non-transient) error, index.html untouched
{
  const dir = tempRepo('2026-10-20');
  const before = readFileSync(path.join(dir, 'index.html'), 'utf8');
  await assert.rejects(
    main(opts({ root: dir, providers: [mockProvider('x', { failWith: new GenerationError('HTTP 400', false) })], fetchFn: counter(1) })),
    e => e.transient === false
  );
  assert.equal(readFileSync(path.join(dir, 'index.html'), 'utf8'), before);
  rmSync(dir, { recursive: true });
}
// force refresh ignores the counter
{
  const dir = tempRepo('2026-10-22');
  const r = await main(opts({ root: dir, env: { FORCE_REFRESH: 'true' }, providers: [mockProvider('ok')], fetchFn: counter('down') }));
  assert.equal(r.status, 'refreshed');
  rmSync(dir, { recursive: true });
}
console.log('main() failure + force paths: OK');

console.log('\nALL DRY-RUN CHECKS PASSED');
