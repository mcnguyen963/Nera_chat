#!/usr/bin/env node
// Zero-dependency ratchets for gates that cannot start at zero.
// node scripts/ratchet.mjs tsc [--update] runs `tsc -p jsconfig.json` (checkJs);
// per-file error counts may not grow, files absent from the baseline must have 0 errors,
// and errors without a file (config/CLI errors) always fail.
// node scripts/ratchet.mjs coverage [--update] reads coverage/coverage-summary.json (c8 json-summary);
// total line/branch/function % may not drop by more than TOL_TOTAL, a file's line % by
// more than TOL_FILE, and new js/ files need at least NEW_FILE_FLOOR % lines.
// --update rewrites scripts/ratchet-baseline.json from the current numbers (commit the diff).
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'ratchet-baseline.json');
const TOL_TOTAL = 0.25, TOL_FILE = 1, NEW_FILE_FLOOR = 50;
const [mode, ...rest] = process.argv.slice(2);
const update = rest.includes('--update');
const rel = p => relative(ROOT, p).split(sep).join('/');

let base = {};
try { base = JSON.parse(await readFile(BASELINE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const save = async next => { await writeFile(BASELINE, JSON.stringify({ ...base, ...next }, null, 2) + '\n'); console.log(`updated ${rel(BASELINE)} [${mode}]`); };
const fail = [];

if (mode === 'tsc') {
  // Spawned (not piped) so a missing or crashing tsc fails instead of looking like "0 errors".
  const pkg = join(ROOT, 'node_modules', 'typescript');
  const tsc = join(pkg, JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).bin.tsc); // throws if not installed
  const r = spawnSync(process.execPath, [tsc, '-p', join(ROOT, 'jsconfig.json'), '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || ![0, 1, 2].includes(r.status) || r.stderr.trim()) { console.error(`tsc did not run cleanly (status ${r.status}): ${r.error?.message ?? r.stderr}`); process.exit(2); }
  const input = r.stdout;
  const counts = {}, global = [];
  for (const line of input.split('\n')) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error TS\d+/);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    else if (/error TS\d+/.test(line)) global.push(line);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (global.length) { console.error(global.join('\n')); process.exit(1); }
  if (update) { await save({ tsc: Object.fromEntries(Object.entries(counts).sort()) }); process.exit(0); }
  const known = base.tsc ?? {};
  for (const [file, n] of Object.entries(counts)) if (n > (known[file] ?? 0)) fail.push(`${file}: ${n} type errors (baseline ${known[file] ?? 0})`);
  fail.push(...global);
  const improved = Object.keys(known).filter(f => (counts[f] ?? 0) < known[f]);
  console.log(`tsc: ${total} errors in ${Object.keys(counts).length} files (baseline ${Object.values(known).reduce((a, b) => a + b, 0)})`);
  if (improved.length) console.log(`improved, run --update to lock in: ${improved.join(', ')}`);
} else if (mode === 'coverage') {
  const summary = JSON.parse(await readFile(join(ROOT, 'coverage', 'coverage-summary.json'), 'utf8'));
  const files = Object.fromEntries(Object.entries(summary).filter(([k]) => k !== 'total').map(([k, v]) => [rel(k), v.lines.pct]));
  const total = Object.fromEntries(['lines', 'branches', 'functions'].map(k => [k, summary.total[k].pct]));
  if (update) { await save({ coverage: { total, files: Object.fromEntries(Object.entries(files).sort()) } }); process.exit(0); }
  if (!base.coverage) {                       // bootstrap: the first run only reports; lock it in with --update
    console.log(`coverage: lines ${total.lines}% branches ${total.branches}% functions ${total.functions}% (no baseline yet: run \`node scripts/ratchet.mjs coverage --update\` and commit)`);
    process.exit(0);
  }
  const known = base.coverage;
  for (const [k, pct] of Object.entries(total)) if (known.total[k] !== undefined && pct < known.total[k] - TOL_TOTAL) fail.push(`total ${k}: ${pct}% < baseline ${known.total[k]}%`);
  for (const [file, pct] of Object.entries(files)) {
    const was = known.files[file];
    if (was === undefined ? pct < NEW_FILE_FLOOR : pct < was - TOL_FILE) fail.push(`${file}: lines ${pct}% (${was === undefined ? `new file, floor ${NEW_FILE_FLOOR}` : `baseline ${was}`}%)`);
  }
  console.log(`coverage: lines ${total.lines}% branches ${total.branches}% functions ${total.functions}%`);
} else { console.error('usage: ratchet.mjs tsc|coverage [--update]'); process.exit(2); }

for (const f of fail) console.log(`FAIL ${f}`);
process.exitCode = fail.length ? 1 : 0;
