#!/usr/bin/env node
// Run the suite once; rerun only the files that failed, once each, in isolation.
// A file that passes on rerun is reported as FLAKY (GitHub warning annotation, listed in
// $GITHUB_STEP_SUMMARY) and does not fail the job; a file that fails twice fails the job.
// Extra node flags (e.g. coverage is collected through NODE_V8_COVERAGE) pass through the env.
// Usage: node scripts/test-rerun.mjs [test files...] (default: tests/*.mjs)
import { spawn } from 'node:child_process';
import { readdir, appendFile } from 'node:fs/promises';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = ['--experimental-vm-modules', '--test'];
const files = process.argv.length > 2 ? process.argv.slice(2)
  : (await readdir(join(ROOT, 'tests'))).filter(f => f.endsWith('.mjs')).sort().map(f => `tests/${f}`);
const rel = p => relative(ROOT, resolve(ROOT, p)).split(sep).join('/');

function run(list) {
  return new Promise(done => {
  // spec for humans on stdout, TAP (which carries each failure's file location) parsed here.
  const child = spawn(process.execPath, [...FLAGS, '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=tap', '--test-reporter-destination=stderr', ...list], { cwd: ROOT, stdio: ['ignore', 'inherit', 'pipe'] });
  let tap = '';
  child.stderr.on('data', d => { tap += d; });
  child.on('close', code => {
  const failed = new Set(), lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
  if (!/^not ok \d+ /.test(lines[i])) continue; // top-level failures only
  for (let j = i + 1; j < lines.length && !/^(not )?ok \d+ /.test(lines[j]); j++) {
  const m = lines[j].match(/^ {2}location: '(.+?):\d+:\d+'/);
  if (m) { failed.add(rel(m[1])); break; }
  }
  }
  // Non-TAP stderr (e.g. a crash before reporting) is still shown.
  const noise = lines.filter(l => l && !/^(TAP version|#|\s|ok |not ok |1\.\.|---|\.\.\.)/.test(l));
  if (noise.length) process.stderr.write(noise.join('\n') + '\n');
  done({ code, failed: [...failed].filter(f => list.includes(f)) });
  });
  });
}

const first = await run(files);
if (first.code === 0) process.exit(0);
if (!first.failed.length) { console.error('test-rerun: suite failed but no failing file could be identified; not retrying.'); process.exit(first.code || 1); }
console.log(`\ntest-rerun: retrying ${first.failed.length} failed file(s) once: ${first.failed.join(' ')}`);
const flaky = [], broken = [];
for (const f of first.failed) ((await run([f])).code === 0 ? flaky : broken).push(f);
for (const f of flaky) console.log(`::warning file=${f}::FLAKY: ${f} failed in the full run and passed on isolated rerun`);
if (process.env.GITHUB_STEP_SUMMARY && (flaky.length || broken.length)) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Test reruns (node ${process.version})\n${flaky.map(f => `- flaky: \`${f}\``).join('\n')}\n${broken.map(f => `- failed twice: \`${f}\``).join('\n')}\n`);
}
console.log(`test-rerun: ${flaky.length} flaky, ${broken.length} failed twice`);
process.exit(broken.length ? 1 : 0);
