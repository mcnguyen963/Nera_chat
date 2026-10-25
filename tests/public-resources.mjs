import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/check-public-resources.py', import.meta.url));
const check = dir => spawnSync('python3', [script, '--pets-dir', dir], { encoding:'utf8' });

test('public pet assets allow built-in sheets and reject story documents and reference art', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nera-public-assets-'));
  try {
    await writeFile(join(dir, 'manifest.json'), '["pet.png"]');
    await writeFile(join(dir, 'pet.png'), 'image fixture');
    assert.equal(check(dir).status, 0);
    for (const name of ['character-card.md', 'story.jsonl', 'request.json', 'summary.txt']) {
      await writeFile(join(dir, name), 'private fixture');
      const result = check(dir);
      assert.notEqual(result.status, 0, name);
      assert.ok(result.stderr.includes(name), result.stderr);
      await rm(join(dir, name));
    }
    await mkdir(join(dir, 'character concept'));
    await writeFile(join(dir, 'character concept', 'reference.png'), 'private image fixture');
    assert.notEqual(check(dir).status, 0);
  } finally {
    await rm(dir, { recursive:true, force:true });
  }
});

test('repository public pet assets pass the privacy check', () => {
  const result = check(fileURLToPath(new URL('../resources/pets/', import.meta.url)));
  assert.equal(result.status, 0, result.stderr);
});
