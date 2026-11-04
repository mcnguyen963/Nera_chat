#!/usr/bin/env node
// Zero-dependency QC checks for the build-free app (Node >= 20, no npm install needed):
// dead-export exported names nobody imports (app or tests)
// unreachable-module js/ files not reachable from index.html <script type=module> / new Worker()
// cycle static import cycles (Tarjan SCC; dynamic import() breaks cycles by design)
// prompt "system prompts/*.md" registry drift: unregistered files, missing files,
// unused keys, unknown prompts.KEY references, renderPrompt() placeholders
// passed but absent from the template, or present but never filled
// file-size per-file line/byte budget for js/ (oversize files may not grow)
// New findings fail; findings recorded in scripts/qc-baseline.json are tolerated (ratchet:
// fixed entries are reported as stale so the baseline only shrinks).
// Usage: node scripts/qc-check.mjs [--update-baseline] [--json] [--verbose]
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'qc-baseline.json');
const PROMPT_DIR = 'system prompts';
const REGISTRY = 'js/system-prompts.js';
const BUDGET = { lines: 800, bytes: 64 * 1024 };
const SKIP = /^js\/(vendor\/|firebase-config(\.example)?\.js$)/;
const args = new Set(process.argv.slice(2));

async function walk(dir, test) {
  const out = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
  const p = posix.join(dir, e.name);
  if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') out.push(...await walk(p, test)); }
  else if (test(p)) out.push(p);
  }
  return out.sort();
}
const read = p => readFile(join(ROOT, p), 'utf8');

// Blank comments (keep strings and newlines) so commented-out code is ignored and offsets stay valid.
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
  if (c === '/' && src[i + 1] === '*') {
  const end = src.indexOf('*/', i + 2), stop = end < 0 ? src.length : end + 2;
  out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue;
  }
  if (c === '"' || c === "'" || c === '`') {
  const start = i++;
  while (i < src.length && src[i] !== c && !(c !== '`' && src[i] === '\n')) i += src[i] === '\\' ? 2 : 1;
  i++; out += src.slice(start, i); continue;
  }
  out += c; i++;
  }
  return out;
}
const lineOf = (src, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++; return n; };
const words = src => new Set(src.match(/[A-Za-z_$][\w$]*/g) ?? []);
const esc = s => s.replace(/[$]/g, '\\$');
const resolveSpec = (from, spec) => spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), spec.replace(/[?#].*$/, ''))) : null;
const names = list => list.split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const m = s.match(/^([\w$]+|default)(?:\s+as\s+([\w$]+|default))?$/); return m ? { local: m[1], exported: m[2] ?? m[1] } : null;
}).filter(Boolean);

function parseModule(path, raw) {
  const src = stripComments(raw), exports = new Map(), imports = [];
  // Report the line of the `export` keyword itself, not of leading whitespace matched by \s*.
  const at = m => lineOf(src, m.index + m[0].search(/\b(?:export|import)\b/));
  for (const m of src.matchAll(/^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s*([\w$]+)/gm)) exports.set(m[1], at(m));
  for (const m of src.matchAll(/^[ \t]*export\s+default\s+(?!(?:async\s+)?(?:function|class)\s*\*?\s*[\w$])/gm)) exports.set('default', at(m));
  for (const m of src.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+\{([^}]*)\}/gm)) for (const n of names(m[1].replace(/:\s*[\w$]+/g, '').replace(/=[^,]*/g, ''))) exports.set(n.local, at(m));
  for (const m of src.matchAll(/(?:^|[;\s])export\s*\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\2)?/g)) {
  const target = m[3] && resolveSpec(path, m[3]);
  for (const n of names(m[1])) { exports.set(n.exported, at(m)); if (target) imports.push({ target, name: n.local, kind: 'reexport', line: at(m) }); }
  }
  for (const m of src.matchAll(/export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*(['"])([^'"]+)\1/g)) imports.push({ target: resolveSpec(path, m[2]), name: '*', kind: 'star', line: at(m) });
  for (const m of src.matchAll(/(?:^|[;\s])import\s*([\w$]+)?\s*,?\s*(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?\s*from\s*(['"])([^'"]+)\4/g)) {
  const target = resolveSpec(path, m[5]); if (!target) continue;
  const line = at(m);
  if (m[1]) imports.push({ target, name: 'default', kind: 'static', line });
  if (m[2] !== undefined) for (const n of names(m[2])) imports.push({ target, name: n.local, alias: n.exported, kind: 'static', line });
  if (m[3]) imports.push({ target, name: '*', ns: m[3], kind: 'static', line });
  if (!m[1] && m[2] === undefined && !m[3]) imports.push({ target, name: null, kind: 'static', line });
  }
  for (const m of src.matchAll(/(?:^|[;\s])import\s*(['"])([^'"]+)\1/g)) { const t = resolveSpec(path, m[2]); if (t) imports.push({ target: t, name: null, kind: 'static', line: at(m) }); }
  for (const m of src.matchAll(/\bimport\(\s*(['"`])([^'"`$]+)/g)) { const t = resolveSpec(path, m[2]); if (t) imports.push({ target: t, name: '?', kind: 'dynamic', line: at(m) }); }
  for (const m of src.matchAll(/new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*(['"])([^'"]+)\1/g)) { const t = resolveSpec(path, m[2]); if (t) imports.push({ target: t, name: null, kind: 'worker', line: lineOf(src, m.index) }); }
  return { path, src, raw, exports, imports, words: words(src) };
}

// ---------- checks ----------
function deadExports(mods, testWords) {
  const used = new Map([...mods.keys()].map(p => [p, new Set()]));
  for (const mod of mods.values()) for (const imp of mod.imports) {
  const target = mods.get(imp.target); if (!target || !imp.name) continue;
  const set = used.get(imp.target);
  if (imp.name === '*' && imp.ns) {
  // Namespace import: count ns.member uses; passing the bare namespace around uses everything.
  const members = [...mod.src.matchAll(new RegExp(`\\b${esc(imp.ns)}\\s*\\.\\s*([\\w$]+)`, 'g'))].map(m => m[1]);
  const bare = [...mod.src.matchAll(new RegExp(`\\b${esc(imp.ns)}\\b(?!\\s*\\.)`, 'g'))].length > 1;
  for (const n of bare ? target.exports.keys() : members) set.add(n);
  } else if (imp.name === '*' || imp.name === '?') {
  // export * / dynamic import(): any matching identifier in the importer counts as a use.
  for (const n of target.exports.keys()) if (imp.name === '*' || mod.words.has(n)) set.add(n);
  } else set.add(imp.name);
  }
  const out = [];
  for (const mod of mods.values()) for (const [name, line] of mod.exports) {
  if (used.get(mod.path).has(name)) continue;
  const local = [...mod.src.matchAll(new RegExp(`(?<![\\w$.])${esc(name)}\\b`, 'g'))].length > 1;
    const kind = testWords.has(name) ? 'test-only' : local ? 'unneeded-export' : 'dead';
    out.push({ check: 'dead-export', kind, file: mod.path, line, name, key: `dead-export:${mod.path}:${name}` });
  }
  return out;
}

function cycles(mods) {
  const edges = new Map([...mods.keys()].map(p => [p, [...new Set(mods.get(p).imports
  .filter(i => (i.kind === 'static' || i.kind === 'reexport' || i.kind === 'star') && mods.has(i.target)).map(i => i.target))]]));
  let index = 0; const idx = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
  const visit = v => {
  idx.set(v, index); low.set(v, index++); stack.push(v); on.add(v);
  for (const w of edges.get(v)) {
  if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
  else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
  const scc = []; let w; do { w = stack.pop(); on.delete(w); scc.push(w); } while (w !== v);
  if (scc.length > 1 || edges.get(v).includes(v)) { scc.sort(); out.push({ check: 'cycle', file: scc[0], line: 1, name: scc.join(' -> '), key: `cycle:${scc.join('|')}` }); }
  }
  };
  for (const v of edges.keys()) if (!idx.has(v)) visit(v);
  return out;
}

async function unreachable(mods) {
  const html = await read('index.html').catch(() => '');
  const entries = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)].map(m => posix.normalize(m[1].replace(/^\.\//, '').replace(/[?#].*$/, '')));
  const seen = new Set(), todo = entries.filter(e => mods.has(e));
  if (!todo.length) return [{ check: 'unreachable-module', kind: 'no-entry', file: 'index.html', line: 1, name: 'no <script type="module" src="js/..."> found', key: 'unreachable:no-entry' }];
  while (todo.length) { const p = todo.pop(); if (seen.has(p)) continue; seen.add(p); for (const i of mods.get(p).imports) if (mods.has(i.target)) todo.push(i.target); }
  return [...mods.keys()].filter(p => !seen.has(p)).map(p => ({ check: 'unreachable-module', file: p, line: 1, name: p, key: `unreachable:${p}` }));
}

// Top-level keys of the object literal starting at src[open] === '{'; spread => open-ended.
function literalKeys(src, open) {
  const keys = new Set(); let depth = 0, spread = false, expectKey = true;
  for (let i = open; i < src.length; i++) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1; expectKey = false; continue; }
  if ('{[('.includes(c)) { depth++; if (depth === 1) expectKey = true; continue; }
  if ('}])'.includes(c)) { if (--depth === 0) return { keys, spread }; continue; }
  if (depth !== 1) continue;
  if (c === ',') { expectKey = true; continue; }
  if (expectKey && src.startsWith('...', i)) { spread = true; expectKey = false; i += 2; continue; }
  if (expectKey && /[\w$]/.test(c)) { const m = src.slice(i).match(/^([\w$]+)\s*(?=[:,}(])/); if (m) keys.add(m[1]); expectKey = false; i += (m?.[0].length ?? 1) - 1; continue; }
  if (!/\s/.test(c)) expectKey = false;
  }
  return { keys, spread: true };
}

async function prompts(mods, testSrc) {
  const out = [], sp = mods.get(REGISTRY); if (!sp) return out;
  const map = new Map([...sp.src.matchAll(/^\s*"([\w$]+)"\s*:\s*"([^"]+\.md)"/gm)].map(m => [m[1], { file: m[2], line: lineOf(sp.src, m.index + m[0].indexOf('"')) }]));
  const derived = new Set([...(sp.src.match(/prompts\s*=\s*Object\.freeze\(\{\s*\.\.\.loadedPrompts\s*,([^}]*)\}/)?.[1] ?? '').matchAll(/([\w$]+)\s*:/g)].map(m => m[1]));
  const onDisk = (await readdir(join(ROOT, PROMPT_DIR))).filter(f => f.endsWith('.md') && f !== 'README.md');
  const text = new Map(await Promise.all(onDisk.map(async f => [f, await read(`${PROMPT_DIR}/${f}`)])));
  const users = [...mods.values()].filter(m => m === sp || /import\s*\{[^}]*\bprompts\b[^}]*\}\s*from\s*['"][^'"]*system-prompts\.js['"]/.test(m.src));
  const appSrc = [...mods.values()].map(m => m.src).join('\n');
  const mapped = new Set([...map.values()].map(v => v.file));
  for (const f of onDisk) if (!mapped.has(f) && !appSrc.includes(f)) out.push({ check: 'prompt', kind: 'unregistered-file', file: `${PROMPT_DIR}/${f}`, line: 1, name: f, key: `prompt:file:${f}` });
  const refs = new Map();
  for (const mod of users) for (const m of mod.src.matchAll(/(?<![\w$.\-/])(?:prompts|loadedPrompts)\s*(?:\.\s*([\w$]+)|\[\s*['"]([\w$]+)['"]\s*\])/g)) {
  const key = m[1] ?? m[2]; refs.set(key, (refs.get(key) ?? 0) + 1);
  if (!map.has(key) && !derived.has(key)) out.push({ check: 'prompt', kind: 'unknown-key', file: mod.path, line: lineOf(mod.src, m.index), name: `prompts.${key}`, key: `prompt:unknown:${mod.path}:${key}` });
  }
  for (const [key, { file, line }] of map) {
    if (!text.has(file)) out.push({ check: 'prompt', kind: 'missing-file', file: REGISTRY, line, name: file, key: `prompt:missing:${file}` });
  else if (!text.get(file).trim()) out.push({ check: 'prompt', kind: 'empty-file', file: `${PROMPT_DIR}/${file}`, line: 1, name: file, key: `prompt:empty:${file}` });
    if (!refs.has(key)) out.push({ check: 'prompt', kind: testSrc.includes(key) ? 'test-only-key' : 'unused-key', file: REGISTRY, line, name: key, key: `prompt:key:${key}` });
  }
  // renderPrompt(prompts.KEY, { ... }): keys vs {{PLACEHOLDERS}} in the template.
  for (const mod of users) for (const m of mod.src.matchAll(/renderPrompt\(\s*prompts\.([\w$]+)\s*,\s*\{/g)) {
  const entry = map.get(m[1]); if (!entry || !text.has(entry.file)) continue;
  const have = new Set([...text.get(entry.file).matchAll(/\{\{([A-Z_]+)\}\}/g)].map(x => x[1]));
  const { keys, spread } = literalKeys(mod.src, m.index + m[0].length - 1), line = lineOf(mod.src, m.index);
  for (const k of keys) if (/^[A-Z_]+$/.test(k) && !have.has(k)) out.push({ check: 'prompt', kind: 'unknown-placeholder', file: mod.path, line, name: `${entry.file}: {{${k}}} passed but not in template`, key: `prompt:ph:${mod.path}:${m[1]}:${k}` });
    if (!spread) for (const h of have) if (!keys.has(h)) out.push({ check: 'prompt', kind: 'unfilled-placeholder', file: mod.path, line, name: `${entry.file}: {{${h}}} left literal in model input`, key: `prompt:unfilled:${mod.path}:${m[1]}:${h}` });
  }
  return out;
}

async function sizes(paths) {
  const out = [];
  for (const p of paths) {
  const text = await read(p), lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0), bytes = Buffer.byteLength(text);
  if (lines > BUDGET.lines || bytes > BUDGET.bytes) out.push({ check: 'file-size', file: p, line: 1, name: `${lines} lines / ${bytes} bytes (budget ${BUDGET.lines} / ${BUDGET.bytes})`, lines, bytes, key: `size:${p}` });
  }
  return out;
}

// ---------- main ----------
const appFiles = (await walk('js', p => p.endsWith('.js'))).filter(p => !SKIP.test(p));
const testFiles = await walk('tests', p => p.endsWith('.mjs'));
const mods = new Map(await Promise.all(appFiles.map(async p => [p, parseModule(p, await read(p))])));
const testSrc = stripComments((await Promise.all(testFiles.map(read))).join('\n'));
const findings = [...deadExports(mods, words(testSrc)), ...await unreachable(mods), ...cycles(mods), ...await prompts(mods, testSrc), ...await sizes(appFiles)];
const informational = f => f.kind === 'test-only' || f.kind === 'test-only-key';

let baseline = { keys: [], sizes: {} };
try { baseline = JSON.parse(await readFile(BASELINE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (args.has('--update-baseline')) {
  const next = { note: 'Ratchet: entries may only be removed. Adding one needs review (prefer fixing).',
  keys: findings.filter(f => f.check !== 'file-size' && !informational(f)).map(f => f.key).sort(),
  sizes: Object.fromEntries(findings.filter(f => f.check === 'file-size').map(f => [f.file, { lines: f.lines, bytes: f.bytes }])) };
  await writeFile(BASELINE, JSON.stringify(next, null, 2) + '\n');
  console.log(`baseline written: ${next.keys.length} keys, ${Object.keys(next.sizes).length} oversize files`);
  process.exit(0);
}
const known = new Set(baseline.keys);
const fresh = findings.filter(f => {
  if (informational(f)) return false;
  if (f.check === 'file-size') { const b = baseline.sizes?.[f.file]; return !b || f.lines > b.lines || f.bytes > b.bytes; }
  return !known.has(f.key);
});
const live = new Set(findings.map(f => f.key));
const stale = [...known].filter(k => !live.has(k));
const counts = {};
for (const f of findings) { const k = f.kind ? `${f.check}/${f.kind}` : f.check; counts[k] = (counts[k] ?? 0) + 1; }

if (args.has('--json')) console.log(JSON.stringify({ counts, fresh, stale, findings }, null, 2));
else {
  console.log('qc-check totals:', counts);
  for (const f of args.has('--verbose') ? findings : fresh) console.log(`${f.file}:${f.line} ${f.check}${f.kind ? '/' + f.kind : ''} ${f.name}`);
  if (stale.length) console.log(`\n${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} fixed; run --update-baseline to shrink it:\n ${stale.join('\n ')}`);
  console.log(fresh.length ? `\nFAIL: ${fresh.length} new finding(s) not in scripts/qc-baseline.json` : '\nOK: no new findings');
}
process.exitCode = fresh.length ? 1 : 0;
