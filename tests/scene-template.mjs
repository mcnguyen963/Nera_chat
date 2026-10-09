import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

const api = await appHarness()('scene-parser.js');
const template = 'date: DATE · time: TIME OF DAY · place: PLACE · present: FULL NAME, FULL NAME';
const valid = 'date: October 738 · time: evening · place: Hall · present: Mira';
const tag = text => `<scene>${text}</scene>`;

test('F2 echoed scene template is rejected with its specific warning', () => {
  const out = api.readSceneOutput(`Prose.\n${tag(template)}`);
  assert.equal(out.scene, null);
  assert.equal(out.warning, 'Scene tag was the unfilled template.');
  assert.equal(out.clean, 'Prose.');
});

for (const order of ['before', 'after']) test(`F2 rejected template ${order} a filled tag leaves the filled scene`, () => {
  const tags = order === 'before' ? [template, valid] : [valid, template];
  assert.equal(api.readSceneOutput(tags.map(tag).join('\n')).scene, valid);
});

test('F2 placeholders are missing per field with whitespace trimmed', () => {
  assert.equal(api.canonicalScene('place: PLACE · date: October 738 · time: evening · present: A'),
    'date: October 738 · time: evening · place: unknown · present: A');
  assert.equal(api.canonicalScene(' date:  DATE  · time: evening · place: Hall'),
    'date: unknown · time: evening · place: Hall · present: unknown');
});

test('F2 present names retain real names and omit placeholders', () => {
  assert.equal(api.canonicalScene('present: FULL NAME, Mira'),
    'date: unknown · time: unknown · place: unknown · present: Mira');
  assert.equal(api.canonicalScene('date: unknown · time: unknown · place: unknown · present: unknown'), null);
});

test('F2 dash separates scene keys while preserving non-scene annotations', () => {
  assert.equal(api.canonicalScene('place: Hall - note: east · present: A'),
    'date: unknown · time: unknown · place: Hall - note: east · present: A');
  assert.equal(api.canonicalScene('place: Hall - east wing · present: A'),
    'date: unknown · time: unknown · place: Hall - east wing · present: A');
  assert.equal(api.canonicalScene('place: Hall - where: Gallery - people: A'),
    'date: unknown · time: unknown · place: Gallery · present: A');
});

test('F2 hard separators and active event periods still end scene fields', () => {
  assert.equal(api.canonicalScene(`${valid} · active event: the hearing`), valid);
  assert.equal(api.canonicalScene('Date: Day 2. Active event: the hearing. Present: Mira'),
    'date: Day 2 · time: unknown · place: unknown · present: Mira');
});
