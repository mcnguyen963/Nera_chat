import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
for(const kind of ['flaky','broken','import-crash'])test('test runner handles '+kind,async()=>{
 const root=await mkdtemp(join(tmpdir(),'nera-rerun-'));
 try{
  await mkdir(join(root,'scripts'));await mkdir(join(root,'tests'));await copyFile(new URL('../scripts/test-rerun.mjs',import.meta.url),join(root,'scripts/test-rerun.mjs'));
  const code=kind==='import-crash'?"throw Error('import failure');":kind==='broken'?"import test from 'node:test';test('broken',()=>{throw Error('permanent failure');});":"import test from 'node:test';import {existsSync,writeFileSync} from 'node:fs';test('flaky',()=>{if(!existsSync('once')){writeFileSync('once','1');throw Error('first run');}});";
  await writeFile(join(root,'tests/probe.mjs'),code);let result;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  try{result={code:0,...await exec(process.execPath,[join(root,'scripts/test-rerun.mjs')],{cwd:root,env})};}catch(e){result=e;}
  assert.equal(result.code,kind==='flaky'?0:1);assert.match(result.stdout,/retrying 1 failed file/);assert.match(result.stdout,kind==='flaky'?/FLAKY.*probe\.mjs/:/1 failed twice/);
 }finally{await rm(root,{recursive:true,force:true});}
});
