import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeQualityCase,qualityDigest,summarizeQuality,assertEmbeddingModelAllowed,auditRequest,createEvaluationLoreProxy} from './tools/embedding-quality-core.mjs';
const result=(system,split='development')=>({id:system+'-'+split,system,split,group:'facts',budget:system==='history'?1200:0,anchorHit:true,apiMessages:[{role:'user',content:'The antidote is willow bark.'}],addedPassages:[{text:'The antidote is willow bark.'}]});
const review=r=>({fingerprint:qualityDigest(r),requirementsSatisfied:true,reason:'The request includes the required antidote and no conflicting evidence.',passages:r.addedPassages.map(p=>({hash:qualityDigest(p),judgment:'relevant',reason:'Direct evidence for the requested antidote.'}))});
test('evidence-anchor hits alone cannot pass strict embedding quality',()=>{
  const r=result('history');assert.equal(gradeQualityCase(r,null).pass,false);
  assert.equal(gradeQualityCase(r,review(r)).pass,true);
  const bad=review(r);bad.passages[0].judgment='unrelated';assert.equal(gradeQualityCase(r,bad).pass,false);
  assert.equal(gradeQualityCase({...r,apiMessages:[{role:'user',content:'Different request'}]},review(r)).pass,false);
});
test('unsupported premises and unverified alternatives remain failures',()=>{
  const r={...result('history'),unsupported:true},audit=review(r);assert.equal(gradeQualityCase(r,audit).pass,false);
  audit.unsupportedPremiseChecked=true;assert.equal(gradeQualityCase(r,audit).pass,true);
  const missing={...r,anchorHit:false},alternative={...review(missing),unsupportedPremiseChecked:true,alternativeEvidence:[{text:'Not actually in the request',reason:'Claimed alternative'}]};
  assert.equal(gradeQualityCase(missing,alternative).pass,false);
});
test('4b requires audited complete and fresh 0.6b scores for both systems',()=>{
  const run={model:'qwen3-embedding:0.6b',results:['lore','history'].flatMap(s=>['development','fresh'].map(split=>result(s,split)))};
  assert.throws(()=>assertEmbeddingModelAllowed('qwen3-embedding:4b',run,[]),/locked/);
  const reviews=run.results.map(review);assert.equal(summarizeQuality(run,reviews).passingBudget,1200);assert.doesNotThrow(()=>assertEmbeddingModelAllowed('qwen3-embedding:4b',run,reviews));
  run.caseManifest=[...run.results.map(({id,system,split})=>({id,system,split})),{id:'missing',system:'lore',split:'fresh'}];
  assert.throws(()=>assertEmbeddingModelAllowed('qwen3-embedding:4b',run,reviews),/locked/);
});
test('compact archives reconstruct and verify the actual final request',()=>{
  const base=[{role:'system',content:'Narrate'},{role:'user',content:'Question'}],recallMessage={role:'user',content:'Historical evidence'},messages=[base[0],recallMessage,base[1]];
  const r={baseRequestHash:qualityDigest(base),recallMessage,requestHash:qualityDigest(messages)};
  assert.deepEqual(auditRequest(r,{[r.baseRequestHash]:base}),messages);
  assert.throws(()=>auditRequest({...r,requestHash:'wrong'},{[r.baseRequestHash]:base}),/hash mismatch/);
});
test('an explicit later user comparison authorization does not change the 0.6b quality gate',()=>{
  const authorization={model:'qwen3-embedding:4b',scope:'comparison',authorizedAt:'2026-11-01T00:00:00Z',userInstruction:'You can try 4b now, keeping memory limits in mind.'};
  assert.doesNotThrow(()=>assertEmbeddingModelAllowed('qwen3-embedding:4b',null,[],{},authorization));
  assert.throws(()=>assertEmbeddingModelAllowed('qwen3-embedding:4b',null,[],{},{...authorization,userInstruction:''}),/locked/);
  assert.throws(()=>assertEmbeddingModelAllowed('other-model',null,[],{},authorization),/permits only/);
  assert.equal(summarizeQuality({model:'qwen3-embedding:0.6b',results:[]}).passingBudget,null);
});
test('the evaluator off comparison cannot enable semantic lore through its proxy',async()=>{
  const calls=[],proxy=createEvaluationLoreProxy({search:async options=>{calls.push(options);return {ids:['mira'],status:'ready'};}},'evaluation-owner');
  assert.deepEqual(await proxy.search({mem:{semanticLore:false},query:'antidote'}),{ids:[],status:'off'});assert.equal(calls.length,0);
  const options={owner:'other',mem:{semanticLore:true,semanticModel:'local'},query:'antidote'};await proxy.search(options);
  assert.equal(calls.length,1);assert.equal(calls[0].mem,options.mem);assert.equal(calls[0].owner,'evaluation-owner');
});
