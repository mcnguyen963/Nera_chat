import {loreSemantic,loreIndexProgress} from './lore-semantic.js';
import {usableLore} from './continuity.js';

// One worker per story. Persist intent before work; the semantic index stages
// completed batches and only publishes a complete, still-current generation.
export function createLoreIndexUpdater({getSnapshot,ownerNow,index=loreSemantic.index,needsRefresh=loreSemantic.needsRefresh,storage=loreIndexProgress,onStatus=()=>{}}) {
  const jobs=new Map();
  const keyOf=(owner,sid)=>JSON.stringify([owner,sid]);
  const enabled=s=>s?.historyComplete && s.session?.memory?.semanticLore;
  const signature=s=>JSON.stringify([s.storyEpoch,s.session.loreRevision,s.session.memory,s.session.contentEditsFloor,s.session.contentEdits,s.session.memoryInvalidations]);
  function publish(job,status,message=''){job.status=status;onStatus({owner:job.owner,sessionId:job.sid,status,message});}
  function jobFor(owner,sid){const key=keyOf(owner,sid);if(!jobs.has(key))jobs.set(key,{owner,sid,version:0,status:'idle',writes:Promise.resolve()});return jobs.get(key);}
  async function drain(job) {
    while(ownerNow()===job.owner && !job.stopped) {
      try{if(!await job.writes)throw new Error('Could not save search-update progress on this device.');}
      catch(error){if(!job.stopped)publish(job,'failed',error.message);return;}
      if(job.stopped)return;
      const snapshot=getSnapshot(job.sid),version=job.version;
      if(!enabled(snapshot)){publish(job,'pending');return;}
      const captured=structuredClone({session:snapshot.session,messages:snapshot.messages,entries:snapshot.entries,storyEpoch:snapshot.storyEpoch,historyComplete:snapshot.historyComplete}),source=signature(captured),controller=job.controller=new AbortController();
      const check=()=>{const live=getSnapshot(job.sid);if(controller.signal.aborted || ownerNow()!==job.owner || job.version!==version || !enabled(live) || live.session.id!==job.sid || signature(live)!==source)throw new Error('Lore changed; search update will resume.');};
      try {
        publish(job,'running');
        await index({owner:job.owner,sid:job.sid,mem:captured.session.memory,entries:usableLore(captured.entries,captured.messages,captured.session).entries,signal:controller.signal,check});
        check();
        if(!await storage.save(job.owner,job.sid,false,check))throw new Error('Could not save search-update progress on this device.');
        check();publish(job,'success');return;
      } catch(error) {
        if(job.version!==version && ownerNow()===job.owner)continue;
        if(ownerNow()===job.owner && !controller.signal.aborted)publish(job,'failed',String(error.message).slice(0,200));
        return;
      }
    }
  }
  async function request(snapshot) {
    const owner=ownerNow(),sid=snapshot?.session?.id;
    if(!owner || !sid || !snapshot.session.memory?.semanticLore)return;
    const job=jobFor(owner,sid);job.stopped=false;const version=++job.version;job.controller?.abort();publish(job,'pending');
    job.writes=job.writes.catch(()=>{}).then(()=>storage.save(owner,sid,true,()=>{if(ownerNow()!==owner || job.version!==version || job.stopped)throw new Error('Search update superseded.');}));
    try{if(!await job.writes)throw new Error('Could not save search-update progress on this device.');}
    catch(error){if(job.version===version && !job.stopped)publish(job,'failed',error.message);return;}
    if(!job.running){job.running=drain(job).finally(()=>{job.running=null;});}
    return job.running;
  }
  async function resume(snapshot) {
    const owner=ownerNow(),sid=snapshot?.session?.id;if(!owner || !sid || !enabled(snapshot))return;
    const job=jobs.get(keyOf(owner,sid));if(job?.running)return job.running;
    if(await storage.load(owner,sid))return request(snapshot);
    // A crash can happen between the canonical save and persisting the queue.
    // Compare saved sources on reopen so that gap cannot leave a stale index.
    const captured=structuredClone({session:snapshot.session,messages:snapshot.messages,entries:snapshot.entries}),source=signature(snapshot);
    const refresh=await needsRefresh({owner,sid,mem:captured.session.memory,entries:usableLore(captured.entries,captured.messages,captured.session).entries});
    const live=getSnapshot(sid);
    if(refresh && ownerNow()===owner && enabled(live) && signature(live)===source)return request(live);
  }
  function stop(owner,sid){for(const job of jobs.values())if(job.owner===owner && (!sid || sid===job.sid)){job.stopped=true;job.version++;job.controller?.abort();publish(job,'idle');}}
  return {request,resume,stop,status:(owner,sid)=>jobs.get(keyOf(owner,sid))?.status ?? 'idle',wait:async(owner,sid)=>{await jobs.get(keyOf(owner,sid))?.running;}};
}
