import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('coverage remapping attributes real and appended VM sources and rejects mismatched sources',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'nera-coverage-')));
 try{
  for(const dir of ['scripts','js','raw'])await mkdir(join(root,dir));await copyFile(new URL('../scripts/coverage-remap.mjs',import.meta.url),join(root,'scripts/coverage-remap.mjs'));
  const source='export function alpha(){return 1;}\n';await writeFile(join(root,'js/example.js'),source);
  const script=(url,length,inside=7)=>({scriptId:'1',url,functions:[{functionName:'',isBlockCoverage:true,ranges:[{startOffset:0,endOffset:length,count:1}]},{functionName:'alpha',isBlockCoverage:true,ranges:[{startOffset:inside,endOffset:length,count:1}]}]});
  const actual=script('example.js',source.length),appended=script('example.js',source.length+100),mismatched=script('example.js',source.length+100,source.length-1),external=script('file:///external.js',40);
  // A named function at a changed offset must not validate edited source.
  mismatched.functions[1].functionName='unrelated';
  await writeFile(join(root,'raw/input.json'),JSON.stringify({result:[actual,appended,mismatched,external]}));
  await exec(process.execPath,[join(root,'scripts/coverage-remap.mjs'),join(root,'raw'),join(root,'out')]);
  const out=JSON.parse(await readFile(join(root,'out/input.json'),'utf8')).result;assert.equal(out.length,3);assert.equal(out[0].url,pathToFileURL(join(root,'js/example.js')).href);assert.equal(out[1].functions[0].ranges[0].endOffset,source.length);assert.equal(out[2].url,external.url);
 }finally{await rm(root,{recursive:true,force:true});}
});
