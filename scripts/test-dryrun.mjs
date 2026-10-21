// Offline checks for scripts/generate-questions.mjs — no API keys or network.
// Run: node scripts/test-dryrun.mjs
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  BATCHES, TOTAL, COUNTER_NS, GenerationError, istDate, readSetId, stripFences,
  checkQuestion, parseBatch, buildPrompt, buildReviewPrompt, main,
} from './generate-questions.mjs';

const ROOT = new URL('..', import.meta.url);
const realHtml = readFileSync(new URL('index.html', ROOT), 'utf8');

// --- helpers ---
assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
assert.equal(istDate(new Date('2026-10-20T18:29:00Z')), '2026-10-20');
assert.equal(istDate(new Date('2026-10-20T18:31:00Z')), '2026-10-21', 'IST rolls over at 18:30 UTC');
assert.match(readSetId(realHtml), /^\d{4}-\d{2}-\d{2}$/);
assert.ok(realHtml.includes(`const COUNTER_NS = '${COUNTER_NS}';`), 'index.html and script must share COUNTER_NS');
assert.equal(TOTAL, 100);
assert.deepEqual([0, 1, 2].map(d => BATCHES.filter(b => b.d === d).reduce((s, b) => s + b.n, 0)), [30, 40, 30]);
console.log('helpers: OK');

// --- per-question validation ---
const good = { t: 'vy', q: 'रामस्य पिता कः ?', a: ['दशरथः', 'जनकः', 'वसिष्ठः', 'विश्वामित्रः'] };
assert.equal(checkQuestion(good, ['vy']), null);
assert.match(checkQuestion({ ...good, t: 'rc' }, ['vy']), /not allowed/);
assert.match(checkQuestion({ ...good, q: 'Who is Rama?' }, ['vy']), /Devanagari/);
assert.match(checkQuestion({ ...good, q: 'रामस्य father कः ?' }, ['vy']), /Latin/);
assert.match(checkQuestion({ ...good, a: good.a.slice(0, 3) }, ['vy']), /4/);
assert.match(checkQuestion({ ...good, a: ['दशरथः', 'दशरथः ।', 'जनकः', 'वसिष्ठः'] }, ['vy']), /distinct/);
console.log('checkQuestion(): OK');

// --- tolerant batch parsing: drops bad / duplicate items, honours limit ---
{
  const seen = new Set();
  const items = [good, { ...good, q: 'What?' }, { ...good }, { ...good, q: 'सीतायाः पिता कः ?' }, { ...good, q: 'लक्ष्मणस्य माता का ?' }];
  const { questions, errors } = parseBatch('```json\n' + JSON.stringify({ questions: items }) + '\n```', { d: 1, topics: ['vy'] }, seen, 2);
  assert.equal(questions.length, 2);
  assert.ok(questions.every(q => q.d === 1));
  assert.ok(errors.some(e => e.includes('duplicate')) && errors.some(e => e.includes('Devanagari')));
  assert.equal(parseBatch('not json', { d: 0, topics: ['vy'] }, new Set(), 5).questions.length, 0);
}
console.log('parseBatch(): OK');

// --- prompts ---
assert.ok(buildPrompt({ ...BATCHES[0], avoid: ['पूर्वप्रश्नः ?'] }).includes('पूर्वप्रश्नः ?'));
assert.ok(buildReviewPrompt([{ ...good, d: 0 }]).includes('claimed correct: दशरथः'));
console.log('prompts: OK');

// --- end-to-end against a temp copy of the repo ---
const DV = '०१२३४५६७८९';
const dv = n => String(n).replace(/\d/g, d => DV[d]);
let qCounter = 0;

// Mock LLM: answers generation prompts with unique valid questions (plus one
// junk item), and review prompts by flagging question 0 the first few times.
function mockProvider(name, { failWith } = {}) {
  let reviews = 0;
  return {
    name,
    calls: 0,
    prompts: [],
    async call(prompt) {
      this.calls++;
      this.prompts.push(prompt);
      if (failWith) throw failWith;
      if (prompt.includes('strict Sanskrit scholar')) return JSON.stringify({ bad: reviews++ < 3 ? [0] : [] });
      const n = Number(prompt.match(/Write exactly (\d+) multiple-choice/)[1]);
      const topics = [...prompt.matchAll(/^ {2}- "(\w\w)":/gm)].map(m => m[1]);
      const questions = Array.from({ length: n }, (_, i) => {
        const k = qCounter++;
        return { t: topics[i % topics.length], q: `परीक्षाप्रश्नः ${dv(k)} किम् ?`, a: [`उत्तरम् ${dv(k)}क`, `उत्तरम् ${dv(k)}ख`, `उत्तरम् ${dv(k)}ग`, `उत्तरम् ${dv(k)}घ`] };
      });
      questions.push({ t: topics[0], q: 'English junk', a: ['a', 'b', 'c', 'd'] });
      return JSON.stringify({ questions });
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
const opts = extra => ({ env: {}, now: NOW, log: quiet, backoffMs: [0], counterRetryMs: 0, ...extra });

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
  assert.equal(readFileSync(path.join(dir, 'index.html'), 'utf8').includes("const SET_ID = '2026-10-20';"), true);
  rmSync(dir, { recursive: true });
}
// counter unreachable → transient error (retried by a later slot)
{
  const dir = tempRepo('2026-10-20');
  await assert.rejects(main(opts({ root: dir, providers: [mockProvider('mock')], fetchFn: counter('down') })), e => e.transient === true);
  rmSync(dir, { recursive: true });
}
console.log('main() skip paths: OK');

// refresh: first provider overloaded (503), second has a bad key (403), third works
{
  const dir = tempRepo('2026-10-20');
  const overloaded = mockProvider('overloaded', { failWith: new GenerationError('HTTP 503', true) });
  const badKey = mockProvider('bad-key', { failWith: new GenerationError('HTTP 403', false) });
  const ok = mockProvider('ok');
  const r = await main(opts({ root: dir, providers: [overloaded, badKey, ok], fetchFn: counter(2) }));
  assert.equal(r.status, 'refreshed', r.reason);
  assert.equal(badKey.calls, 1, 'a permanently failing provider is tried once, then skipped');
  // easy group-A prompt lists recent archived easy "vy" questions (last 10 sets only)
  const easyA = ok.prompts.find(p => p.includes('Difficulty of every question: easy') && p.includes('"vy"'));
  assert.ok(easyA.includes('पुरातनः ३१ ?') && easyA.includes('पुरातनः २२ ?'), 'recent sets go in the avoid list');
  assert.ok(!easyA.includes('पुरातनः २१ ?'), 'older sets are not');
  assert.ok(!ok.prompts.find(p => p.includes('Difficulty of every question: hard')).includes('पुरातनः'), 'avoid list is per difficulty');

  const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.equal(readSetId(html), '2026-10-22');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(script); // syntax check only
  const bank = new Function(script.slice(0, script.indexOf('/* ---------- helpers')) + 'return BANK;')();
  assert.equal(bank.length, 100);
  assert.deepEqual([0, 1, 2].map(d => bank.filter(q => q.d === d).length), [30, 40, 30]);
  assert.equal(new Set(bank.map(q => q.q)).size, 100);
  assert.ok(!bank.some(q => q.q === 'English junk'));
  assert.ok(!realHtml.includes('परीक्षाप्रश्नः') && html.includes('परीक्षाप्रश्नः'));

  const archive = readdirSync(path.join(dir, 'data', 'questions-archive'));
  assert.equal(archive.length, 30, 'archive pruned to newest 30');
  assert.ok(archive.includes('2026-10-22.json') && !archive.includes('2026-08-01.json'));
  const last = JSON.parse(readFileSync(path.join(dir, 'data', 'last-run.json'), 'utf8'));
  assert.equal(last.previousSet, '2026-10-20');
  assert.equal(last.plays, 2);
  rmSync(dir, { recursive: true });
}
console.log('main() refresh with provider fallback + review: OK');

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
