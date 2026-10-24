// Display telemetry is device-local and never replaces request-budget checks.
export function compactTokenReport(report) {
  if(!report)return null;
  return {mode:report.mode,totals:{...report.totals},
    blocks:(report.blocks ?? []).map(({key,label,tokens,budget})=>({key,label,tokens,...(budget==null ? {} : {budget})})),
    warnings:[...(report.warnings ?? [])]};
}
const validTokens=value=>Number.isSafeInteger(value) && value>=0;
export function tokenContextFingerprint(values) {
  const text=JSON.stringify(values);
  let a=2166136261,b=5381;
  for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);a=Math.imul(a^code,16777619);b=Math.imul(b,33)^code;}
  return `${text.length}:${(a>>>0).toString(16)}:${(b>>>0).toString(16)}`;
}
export function createTokenUsageCache({limit=3}={}) {
  const entries=new Map();
  const id=(owner,sid)=>JSON.stringify([owner,sid]);
  function entry(owner,sid) {
    const key=id(owner,sid);
    let value=entries.get(key);
    if(!value){value={display:null,fallback:null,preview:null};entries.set(key,value);}
    entries.delete(key);entries.set(key,value);
    while(entries.size>limit)entries.delete(entries.keys().next().value);
    return value;
  }
  const read=(owner,sid)=>entries.get(id(owner,sid))?.display ?? null;
  function remember(owner,sid,display) {
    if(!validTokens(display.tokens))throw new Error('Invalid input token count.');
    const item=entry(owner,sid);
    item.fallback=null;
    const {kind,tokens,max,reserved,at,modelId,contextKey,droppedCount=0,recentOnly=false}=display;
    item.display={version:1,kind,tokens,max,reserved,at,modelId,contextKey,droppedCount,recentOnly,report:compactTokenReport(display.report)};
    return item.display;
  }
  function restore(owner,sid,saved) {
    if(saved?.version!==1 || !['provider','sent-estimate','estimate'].includes(saved.kind) ||
       !validTokens(saved.tokens) || !Number.isFinite(saved.at) || typeof saved.contextKey!=='string')return read(owner,sid);
    const current=read(owner,sid);
    if(current && (current.kind!=='estimate' && saved.kind==='estimate' ||
      (current.kind==='estimate')===(saved.kind==='estimate') && current.at>=saved.at))return current;
    return remember(owner,sid,saved);
  }
  async function estimate(owner,sid,key,compute,isCurrent=()=>true) {
    const item=entry(owner,sid);
    if(item.display && (item.display.kind!=='estimate' || item.display.contextKey===key))return item.display;
    if(item.fallback?.key===key)return item.fallback.promise;
    const job={key};item.fallback=job;
    const check=()=>{if(entries.get(id(owner,sid))!==item || item.fallback!==job || !isCurrent())throw new Error('Token estimate changed.');};
    job.promise=(async()=>{
      // Install the shared promise before starting the calculation.
      await Promise.resolve();check();
      const display=await compute(check);check();
      return remember(owner,sid,{...display,kind:'estimate',contextKey:key});
    })();
    // Retain failed work for this revision too; reopening must not retry a
    // failing calculation. A context change replaces the job.
    return job.promise;
  }
  async function preview(owner,sid,key,compute,isCurrent=()=>true) {
    const item=entry(owner,sid);
    if(item.preview?.key===key)return item.preview.promise;
    const job={key};item.preview=job;
    const check=()=>{if(entries.get(id(owner,sid))!==item || item.preview!==job || !isCurrent())throw new Error('Context preview changed.');};
    job.promise=(async()=>{await Promise.resolve();check();const result=await compute(check);check();job.ready=true;return result;})();
    try{return await job.promise;}catch(error){if(item.preview===job)item.preview=null;throw error;}
  }
  return {read,remember,restore,estimate,preview,
    hasPreview:(owner,sid,key)=>{const value=entries.get(id(owner,sid))?.preview;return value?.key===key && value?.ready===true;},
    cancelPending:(owner,sid)=>{const value=entries.get(id(owner,sid));if(value){value.fallback=null;if(!value.preview?.ready)value.preview=null;}},
    serialize:(owner,sid)=>{const value=read(owner,sid);return value ? structuredClone(value) : null;},
    clear:()=>entries.clear()};
}

export const tokenUsageCache=createTokenUsageCache();
