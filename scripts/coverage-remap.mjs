#!/usr/bin/env node
// Re-attribute V8 coverage of vm.SourceTextModule instances to the real js/ files.
// Tests load app modules through node:vm, so V8 records them under the module
// identifier ("messages.js", "ui/pet-view.js") or as "vm:module(N)" when no
// identifier is given. c8 only reports file:// URLs, so without this step the
// whole app is invisible to coverage.
//
// Matching: a script is attributed to js/<id> when its top-level range length equals
// that file's length. A longer script with the same identifier (tests that append
// fixture exports to the real source) is kept only if every named function that
// starts inside the file is found at its recorded offset; its ranges are clipped to
// the file. Anything else (edited `sources`) is dropped instead of mis-mapped.
// Anonymous vm:module(N) scripts are matched by length plus function names.
//
// Usage: node scripts/coverage-remap.mjs <in-dir> <out-dir>
import { readFile, readdir, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve, dirname, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [inDir, outDir] = process.argv.slice(2).map(p => resolve(p ?? ''));
if (!inDir || !outDir || inDir === outDir) { console.error('usage: coverage-remap.mjs <in-dir> <out-dir>'); process.exit(2); }

async function walk(dir) {
  const out = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
  const p = posix.join(dir, e.name);
  if (e.isDirectory()) out.push(...await walk(p)); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = new Map(); // 'messages.js' -> { url, length, names }
for (const p of await walk('js')) {
  if (p.startsWith('js/vendor/')) continue;
  const src = await readFile(join(ROOT, p), 'utf8');
  const names = new Set([...src.matchAll(/function\s*\*?\s*([\w$]+)/g)].map(m => m[1]));
  files.set(p.slice(3), { url: pathToFileURL(join(ROOT, p)).href, length: src.length, names, src });
}
const byLength = new Map();
for (const [id, f] of files) byLength.set(f.length, [...(byLength.get(f.length) ?? []), id]);

const scriptLength = r => r.functions.find(fn => fn.functionName === '' && fn.ranges[0]?.startOffset === 0)?.ranges[0].endOffset;
function attribute(r) {
  const len = scriptLength(r);
  if (len === undefined) return null;
  const id = r.url.replace(/^https?:\/\/[^/]+\//, '').replace(/^\.?\//, '').replace(/^js\//, '').replace(/[?#].*$/, '');
  if (files.has(id)) { const f = files.get(id); return f.length === len || (len > f.length && appendedTo(r, f)) ? id : null; }
  if (!/^vm:module\(\d+\)$/.test(r.url) && r.url !== '') return null;
  const named = new Set(r.functions.map(fn => fn.functionName).filter(Boolean));
  const hits = (byLength.get(len) ?? []).filter(c => [...named].every(n => files.get(c).names.has(n) || !/^[\w$]+$/.test(n)));
  return hits.length === 1 ? hits[0] : null;
}

// Real source followed by test-appended code: named functions inside the file must sit at their offsets.
function appendedTo(r, f) {
  const inside = r.functions.filter(fn => fn.functionName && fn.ranges[0].startOffset < f.length);
  return inside.length > 0 && inside.every(fn => {
  const at = fn.ranges[0].startOffset;
  return f.src.slice(Math.max(0, at - fn.functionName.length - 24), at + fn.functionName.length + 24).includes(fn.functionName);
  });
}
const clip = (r, length) => ({ ...r, functions: r.functions
  .filter(fn => fn.ranges[0].startOffset < length)
  .map(fn => ({ ...fn, ranges: fn.ranges.filter(x => x.startOffset < length).map(x => ({ ...x, endOffset: Math.min(x.endOffset, length) })) })) });

await mkdir(outDir, { recursive: true });
// c8 cleans raw input between runs; remapped V8 files must not accumulate.
for(const name of await readdir(outDir))if(/^coverage-.*\.json$/.test(name))await unlink(join(outDir,name));
const stats = { mapped: 0, dropped: 0, files: new Set(), why: new Map() };
for (const name of (await readdir(inDir)).filter(n => n.endsWith('.json'))) {
  const data = JSON.parse(await readFile(join(inDir, name), 'utf8'));
  const result = [];
  for (const r of data.result ?? []) {
  if (r.url.startsWith('file:')) { result.push(r); continue; }
  const id = attribute(r);
  if (id) { const f = files.get(id); result.push({ ...clip(r, f.length), url: f.url }); stats.mapped++; stats.files.add(id); }
  else if (!r.url.startsWith('node:') && r.url !== '') {
  stats.dropped++;
  const key = r.url.replace(/\(\d+\)$/, '(N)');
  stats.why.set(key, (stats.why.get(key) ?? 0) + 1);
  }
  }
  await writeFile(join(outDir, name), JSON.stringify({ result })); // source-map-cache is not needed: no transpilation
}
console.log(`coverage-remap: ${stats.mapped} vm scripts mapped onto ${stats.files.size} app files, ${stats.dropped} unattributed (edited sources / ambiguous / non-app)`);
if (process.argv.includes('--verbose')) for (const [url, n] of [...stats.why].sort((a, b) => b[1] - a[1])) console.log(` unattributed ${n}x ${url}`);
