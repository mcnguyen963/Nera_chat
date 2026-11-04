#!/usr/bin/env node
// Zero-dependency syntax gate: `node --check` every shipped and test module with the
// running Node version (catches syntax the CI matrix's oldest Node cannot parse),
// plus JSON.parse for shipped JSON. Usage: node scripts/check-syntax.mjs
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, posix, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
async function walk(dir) {
  const out = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true }).catch(() => [])) {
  const p = posix.join(dir, e.name);
  if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...await walk(p)); } else out.push(p);
  }
  return out;
}
const all = (await Promise.all(['js', 'tests', 'scripts', 'resources'].map(walk))).flat();
const modules = all.filter(p => /\.(m?js)$/.test(p) && !p.startsWith('resources/'));
const json = all.filter(p => p.endsWith('.json'));
const errors = [];
for (const p of json) { try { JSON.parse(await readFile(join(ROOT, p), 'utf8')); } catch (e) { errors.push(`${p}: ${e.message}`); } }
const queue = [...modules];
await Promise.all(Array.from({ length: Math.min(8, availableParallelism()) }, async () => {
  for (let p; (p = queue.shift());) {
    // .js under "type": "module" and .mjs are both checked as ES modules.
    try { await run(process.execPath, ['--check', join(ROOT, p)]); }
    catch (e) { errors.push(`${p}: ${(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 5).join(' | ')}`); }
  }
}));
for (const e of errors) console.log(`FAIL ${e}`);
console.log(`check-syntax: ${modules.length} modules, ${json.length} JSON files, ${errors.length} errors (node ${process.version})`);
process.exitCode = errors.length ? 1 : 0;
