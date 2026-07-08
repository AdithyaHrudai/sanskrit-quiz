import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ALLOWED_TOPICS, validate, buildTopicsBlock, buildQuestionsBlock, spliceBetween, stripFences } from './generate-questions.mjs';

// --- stripFences ---
assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
assert.equal(stripFences('{"a":1}'), '{"a":1}');

// --- build a fake but schema-valid 100-question payload ---
const topicKeys = Object.keys(ALLOWED_TOPICS);
function mkQ(i, d) {
  const t = topicKeys[i % topicKeys.length];
  return { t, d, q: `प्रश्नः संख्या ${i} किम् अस्ति ?`, a: [`उत्तरम्${i}क`, `उत्तरम्${i}ख`, `उत्तरम्${i}ग`, `उत्तरम्${i}घ`] };
}
const questions = [];
let i = 0;
for (let e = 0; e < 30; e++) questions.push(mkQ(i++, 0));
for (let m = 0; m < 40; m++) questions.push(mkQ(i++, 1));
for (let h = 0; h < 30; h++) questions.push(mkQ(i++, 2));

const raw = JSON.stringify({ questions });
const result = validate(raw);
assert.equal(result.ok, true, `validation should pass: ${JSON.stringify(result.errors)}`);
assert.equal(result.questions.length, 100);
console.log('validate(): OK — 100/100 accepted');

// --- reject wrong counts ---
const bad = validate(JSON.stringify({ questions: questions.slice(0, 99) }));
assert.equal(bad.ok, false);
console.log('validate(): OK — correctly rejects wrong count');

// --- reject duplicate questions ---
const dupQuestions = questions.slice(0, 99).concat([questions[0]]);
const dup = validate(JSON.stringify({ questions: dupQuestions }));
assert.equal(dup.ok, false);
assert.ok(dup.errors.some(e => e.includes('duplicate')));
console.log('validate(): OK — correctly rejects duplicates');

// --- reject non-Devanagari ---
const englishQuestions = questions.slice(0, 99).concat([{ t: 'vy', d: 2, q: 'What is this in English?', a: ['a', 'b', 'c', 'd'] }]);
const eng = validate(JSON.stringify({ questions: englishQuestions }));
assert.equal(eng.ok, false);
console.log('validate(): OK — correctly rejects non-Devanagari');

// --- build blocks ---
const usedKeys = topicKeys; // all used since we cycled through all of them
const topicsBlock = buildTopicsBlock(usedKeys);
assert.ok(topicsBlock.startsWith('const T = {'));
assert.ok(topicsBlock.trim().endsWith('};'));
console.log('buildTopicsBlock(): OK');

const qBlock = buildQuestionsBlock(result.questions, { date: '2026-07-08', provider: 'mock' });
assert.ok(qBlock.startsWith('const BANK = ['));
assert.ok(qBlock.trim().endsWith('];'));
console.log('buildQuestionsBlock(): OK');

// --- splice into a copy of the real index.html and confirm the result is valid JS ---
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let updated = spliceBetween(
  html,
  '/* AUTO-GENERATED:TOPICS:START — overwritten daily by scripts/generate-questions.mjs, do not hand-edit */',
  '/* AUTO-GENERATED:TOPICS:END */',
  topicsBlock
);
updated = spliceBetween(
  updated,
  '/* AUTO-GENERATED:QUESTIONS:START — overwritten daily by scripts/generate-questions.mjs, do not hand-edit */',
  '/* AUTO-GENERATED:QUESTIONS:END */',
  qBlock
);
assert.ok(updated.includes('प्रश्नः संख्या 0 किम्'), 'spliced content should be present');
assert.ok(!updated.includes("श्रीरामस्य पत्नी"), 'old question content should be fully gone');

// Extract the <script> body and check it's syntactically valid JS.
// `new Function(body)` only compiles/parses — it does not execute the body,
// so this is a pure syntax check with no DOM required.
const scriptMatch = updated.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'script tag should exist');
new Function(scriptMatch[1]);
console.log('splice + resulting <script> body: parses without SyntaxError');

console.log('\nALL DRY-RUN CHECKS PASSED');
