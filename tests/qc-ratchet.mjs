import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function fixture(run){
 const root=await mkdtemp(join(tmpdir(),'nera-ratchet-'));
 try{
  for(const dir of ['scripts','coverage','node_modules/typescript'])await mkdir(join(root,dir),{recursive:true});
  await copyFile(new URL('../scripts/ratchet.mjs',import.meta.url),join(root,'scripts/ratchet.mjs'));
  const write=(path,text)=>writeFile(join(root,path),typeof text==='string'?text:JSON.stringify(text));
  await write('node_modules/typescript/package.json',{bin:{tsc:'fake.cjs'}});
  const check=async(...args)=>{try{return {status:0,...await exec(process.execPath,[join(root,'scripts/ratchet.mjs'),...args])};}catch(e){return {status:e.code,stdout:e.stdout,stderr:e.stderr};}};
  await run({root,write,check});
 }finally{await rm(root,{recursive:true,force:true});}
}
test('type ratchet catches growing files and refuses to baseline configuration errors',()=>fixture(async({write,check})=>{
 await write('node_modules/typescript/fake.cjs',"console.log('js/a.js(1,1): error TS2339: fixture');process.exit(2);");
 assert.equal((await check('tsc')).status,1);assert.equal((await check('tsc','--update')).status,0);assert.equal((await check('tsc')).status,0);
 await write('node_modules/typescript/fake.cjs',"console.log('error TS5058: configuration missing');process.exit(2);");
 assert.equal((await check('tsc')).status,1);assert.notEqual((await check('tsc','--update')).status,0);
}));
test('coverage ratchet reports first run and catches drops and uncovered new files',()=>fixture(async({root,write,check})=>{
 const summary=(pct,extra=false)=>({total:{lines:{pct},branches:{pct},functions:{pct}},[join(root,'js/a.js')]:{lines:{pct}},...(extra?{[join(root,'js/new.js')]:{lines:{pct:0}}}:{})});
 await write('coverage/coverage-summary.json',summary(80));assert.equal((await check('coverage')).status,0);assert.equal((await check('coverage','--update')).status,0);assert.equal((await check('coverage')).status,0);
 await write('coverage/coverage-summary.json',summary(70));assert.equal((await check('coverage')).status,1);await write('coverage/coverage-summary.json',summary(80,true));assert.equal((await check('coverage')).status,1);
}));
