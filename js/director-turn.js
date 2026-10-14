import { classifyUserInput } from './scene.js';
import { requestSource, assertSource } from './continuity.js';
import { validateDirectorState, seedDirectorState, parseDirectorContract } from './director-state.js';
import { buildDirectorContext, directorTaskSettings } from './director-context.js';
import { getDirectorTurn, savePendingDirectorTurn } from './director-store.js';
import { chatCompletion } from './llm-client.js';
export async function prepareDirectorTurn(session,settings,messages,entries,opts={},hooks={}) {
  const check=()=>{if(hooks.signal?.aborted)throw Object.assign(new Error('Director stopped.'),{name:'AbortError'});hooks.check?.();};
  check();
  if(session.directorNeedsReview)throw new Error('Director state needs review after a history edit. Open live state in story settings and save your correction.');
  const target=opts.overwriteId && messages.find(m=>m.id===opts.overwriteId);
  const finishing=!!opts.continuationId && target?.truncated;
  const oldId=opts.directorReuseId ?? ((opts.overwriteId && (!opts.continuationId || finishing)) ? target?.directorTurnId : null);
  if(oldId && !opts.replan){
    const old=await getDirectorTurn(session.id,oldId);
    if(old?.status==='discarded')throw new Error('This contract was discarded. Use Re-plan to create a new one.');
    if(!old)throw new Error('Director checkpoint is missing. Re-plan the reply.');
    if(old.status==='completed' && session.directorPending && session.directorPending!==old.id)throw new Error('A replacement contract is pending. Use Re-plan or discard it in live state.');
    if(old.status==='pending')assertSource(session,old.source);
    else if(session.directorCheckpoint!==old.id)throw new Error('Only the latest Director checkpoint can be regenerated.');
    check();return old;
  }
  if(!opts.overwriteId && session.directorPending){
    const pending=await getDirectorTurn(session.id,session.directorPending);
    if(pending?.status==='pending'){
      try{assertSource(session,pending.source);check();return pending;}catch(error){if(error.name==='AbortError')throw error;}
    }
  }
  let before=session.directorState ? validateDirectorState(session.directorState) : seedDirectorState(session,messages,entries);
  let previousCheckpoint=session.directorCheckpoint ?? null;
  if(opts.replan && target?.directorTurnId){const old=await getDirectorTurn(session.id,target.directorTurnId);if(!old)throw new Error('Original Director state is missing.');before=old.before;previousCheckpoint=old.previousCheckpoint ?? null;let steps=0;while(previousCheckpoint && steps++<100){const prior=await getDirectorTurn(session.id,previousCheckpoint);check();if(!prior || prior.assistantId!==target.id)break;before=prior.before;previousCheckpoint=prior.previousCheckpoint ?? null;}}
  if(opts.continuationId && !finishing && before.decisions.some(i=>!['closed','cancelled'].includes(i.status)))return {contract:{action:'wait',objective:'Respond to the pending player decision before continuing.'}};
  const source=requestSource(session),built=await buildDirectorContext(session,settings,messages.filter(m=>m.order<(opts.upToOrder ?? Infinity)),entries,before,{continuation:!!opts.continuationId});
  check();hooks.onContext?.(built);
  const started=Date.now();
  const result=await chatCompletion({settings:directorTaskSettings(settings),messages:built.apiMessages,signal:hooks.signal,onRequest:hooks.onRequest});
  check();
  if(result.finishReason==='length' || !result.content?.trim())throw new Error('Director output was incomplete. Raise its output limit or retry.');
  const parsed=parseDirectorContract(result.content,before,built.entries);
  const input=messages.filter(m=>m.role==='user' && m.order<(opts.upToOrder ?? Infinity)).at(-1)?.content ?? '';
  if(!opts.continuationId && classifyUserInput(input)!=='narrative' && parsed.contract.action!=='answer')throw new Error('Director must answer OOC questions without changing story state. Retry the turn.');
  if(parsed.contract.action==='wait')return {...parsed,usage:result.usage};
  const turn={previousCheckpoint,...(opts.replan && session.directorPending ? {replaces:session.directorPending} : {}),id:'director_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9),...parsed,report:built.report,usage:result.usage ?? null,elapsedMs:Date.now()-started};
  return savePendingDirectorTurn(session.id,turn,source);
}
