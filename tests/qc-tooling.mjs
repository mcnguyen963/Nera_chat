import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function fixture(run){
 const root=await mkdtemp(join(tmpdir(),'nera-qc-'));
 try{for(const dir of ['js','tests','scripts','system prompts'])await mkdir(join(root,dir));
  await copyFile(new URL('../scripts/qc-check.mjs',import.meta.url),join(root,'scripts/qc-check.mjs'));
  await writeFile(join(root,'index.html'),'<script type="module" src="js/main.js"></script>');await writeFile(join(root,'js/main.js'),'');
  const write=(name,text)=>writeFile(join(root,name),text),check=async(...args)=>{try{return {status:0,...await exec(process.execPath,[join(root,'scripts/qc-check.mjs'),...args])};}catch(e){return {status:e.code,stdout:e.stdout};}};
  await run({root,write,check});
 }finally{await rm(root,{recursive:true,force:true});}
}
test('QC gate rejects new dead exports and cycles and permits only its generated baseline',()=>fixture(async({write,check})=>{
 await write('js/main.js',"import './other.js';\nexport function abandoned(){}\n");await write('js/other.js',"import './main.js';\n");
 let r=await check('--json');assert.equal(r.status,1);const report=JSON.parse(r.stdout);assert.ok(report.fresh.some(f=>f.check==='cycle'));assert.ok(report.fresh.some(f=>f.kind==='dead'&&f.name==='abandoned'));
 assert.equal((await check('--update-baseline')).status,0);assert.equal((await check()).status,0);
 await write('js/other.js',"import './main.js';\nexport function anotherUnusedExport(){}\n");r=await check();assert.equal(r.status,1);assert.match(r.stdout,/anotherUnusedExport/);
}));
test('QC gate detects unknown prompt keys and missing template placeholders',()=>fixture(async({write,check})=>{
 await write('js/system-prompts.js','const files={\n"narrator": "narrator.md"\n};\nexport const prompts=files;\nexport const renderPrompt=()=>{};');
 await write('system prompts/narrator.md','Hello {{NAME}}');await write('js/main.js',"import {prompts,renderPrompt} from './system-prompts.js';\nrenderPrompt(prompts.narrator,{WRONG:'Mira'});\nconsole.log(prompts.doesNotExist);\n");
 const r=await check('--json');assert.equal(r.status,1);const fresh=JSON.parse(r.stdout).fresh;for(const kind of ['unknown-key','unknown-placeholder','unfilled-placeholder'])assert.ok(fresh.some(f=>f.kind===kind),kind);
}));
test('QC size baseline rejects growth while allowing shrinkage',()=>fixture(async({write,check})=>{
 await write('js/main.js','// line\n'.repeat(801));assert.equal((await check('--update-baseline')).status,0);await write('js/main.js','// line\n'.repeat(802));assert.equal((await check()).status,1);await write('js/main.js','// line\n'.repeat(800));assert.equal((await check()).status,0);
}));
