import {createHash} from 'node:crypto';
export const qualityDigest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const QUALITY_RUBRIC=Object.freeze({version:1,target:.8,allRequiredEvidence:true,noUnrelatedOrMisleadingPassages:true,unreviewedFails:true});
export function createEvaluationLoreProxy(lore,owner,before=()=>{},after=()=>{}) {
  return {async search(options){
    if(!options.mem.semanticLore)return {ids:[],status:'off'};
    before();try{return await lore.search({...options,owner});}finally{after();}
  }};
}
// Source anchors are necessary probes, not a semantic judge. Every pass needs
// a request-bound audit of the complete question and every added passage.
export function auditRequest(result,requests={}) {
  const base=result.apiMessages ?? requests[result.baseRequestHash];
  if(!base)return [];
  const messages=result.recallMessage ? [base[0],result.recallMessage,...base.slice(1)] : base;
  if(result.requestHash && qualityDigest(messages)!==result.requestHash)throw Error('Captured request hash mismatch.');
  return messages;
}
export function gradeQualityCase(result,review,requests={}) {
  const fingerprint=qualityDigest(result),reasons=[];
  const apiMessages=auditRequest(result,requests);
  if(!apiMessages.length)reasons.push('captured request unavailable');
  if(review?.fingerprint!==fingerprint)reasons.push('missing or stale request review');
  if(review?.requirementsSatisfied!==true || !review?.reason?.trim())reasons.push('complete answer evidence not adjudicated');
  if(!result.anchorHit && !(review?.alternativeEvidence?.length && review.alternativeEvidence.every(e=>e.reason?.trim() && e.text?.trim() && apiMessages.some(m=>m.content.includes(e.text)))))reasons.push('required evidence missing');
  if(result.unsupported && review?.unsupportedPremiseChecked!==true)reasons.push('unsupported premise unresolved');
  for(const passage of result.addedPassages){const judged=review?.passages?.find(p=>p.hash===qualityDigest(passage));if(judged?.judgment!=='relevant' || !judged?.reason?.trim())reasons.push('unreviewed, unrelated or misleading passage');}
  return {id:result.id,system:result.system,split:result.split,group:result.group,budget:result.budget,pass:reasons.length===0,anchorHit:result.anchorHit,reasons:[...new Set(reasons)]};
}
export function summarizeQuality(run,reviews=[],requests={}) {
  const graded=run.results.map(result=>gradeQualityCase(result,reviews.find(r=>r.fingerprint===qualityDigest(result)),requests));
  const summary=[];
  const budgets=[...new Set(graded.filter(r=>r.system==='history').map(r=>r.budget))].sort((a,b)=>a-b);
  for(const budget of budgets.length?budgets:[1200]){
    const groups=[];
    for(const system of ['lore','history'])for(const split of ['complete','fresh','development']){
      const cases=graded.filter(r=>r.system===system && (system==='lore' || r.budget===budget) && (split==='complete' || r.split==='fresh'));
      if(split==='development'){cases.splice(0,cases.length,...graded.filter(r=>r.system===system && (system==='lore'||r.budget===budget) && r.split!=='fresh'));}
      const passed=cases.filter(r=>r.pass).length;
      const expected=run.caseManifest?.filter(c=>c.system===system && (split==='complete' || (split==='fresh'?c.split==='fresh':c.split!=='fresh'))),total=expected?.length ?? cases.length;
      const categories=[...new Set((expected??cases).map(c=>c.group))].map(group=>{const selected=cases.filter(c=>c.group===group),count=expected?.filter(c=>c.group===group).length??selected.length;return {group,total:count,passed:selected.filter(c=>c.pass).length,score:count?selected.filter(c=>c.pass).length/count:0};});
      groups.push({system,split,total,captured:cases.length,passed,score:total?passed/total:0,anchorHits:cases.filter(r=>r.anchorHit).length,categories,missing:expected?.filter(e=>!cases.some(c=>c.id===e.id)).map(e=>e.id)??[],failures:cases.filter(r=>!r.pass)});
    }
    summary.push({budget,passed:groups.filter(g=>g.split!=='development').every(g=>g.total>0 && !g.missing.length && g.captured===g.total && g.score>=QUALITY_RUBRIC.target),groups});
  }
  return {model:run.model,rubric:QUALITY_RUBRIC,passingBudget:summary.find(s=>s.passed)?.budget ?? null,summary};
}
export function assertEmbeddingModelAllowed(model,zeroSixRun,zeroSixReviews,requests={},authorization=null) {
  if(model==='qwen3-embedding:0.6b')return;
  if(model!=='qwen3-embedding:4b')throw new Error('This offline evaluator permits only local Qwen embedding models.');
  // Explicit later user authorization permits a comparison before the original
  // milestone, without claiming that the 0.6b acceptance gate has passed.
  if(authorization?.model===model && authorization.scope==='comparison' && authorization.userInstruction?.trim() && Number.isFinite(Date.parse(authorization.authorizedAt)))return;
  if(zeroSixRun?.model!=='qwen3-embedding:0.6b' || summarizeQuality(zeroSixRun,zeroSixReviews,requests).passingBudget===null)throw new Error('4b is locked until audited 0.6b lore and history scores both pass 80% on complete and fresh suites.');
}
