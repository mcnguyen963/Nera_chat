// Ordered, durable, per-story outbox. Persistence and transport are injected.
import { applyStoryOperation,applyAcknowledgedOperations,previewRecoveredOperation } from './local-story.js';
const transient=e=>['unavailable','deadline-exceeded','aborted','resource-exhausted','internal','network-request-failed'].includes(String(e.code ?? '').replace('firestore/','')) || e instanceof TypeError;
export function createStoryQueue({owner,sid,base,operations=[],recoveryError=null,recoveryBase=base,acknowledgedRecords=[],storage,commit,currentOwner,onChange=()=>{},schedule=setTimeout,cancel=clearTimeout}) {
  let confirmed=base, pending=operations,working=base,error=recoveryError,running=null,timer=null,closed=false,attempt=0,durable=true,paused=false,synced=false;
  let receiptBase=recoveryBase,receipts=acknowledgedRecords;
  const checkpoints=new Set();
  let journal=Promise.resolve();
  const rebuild=()=>{working=pending.reduce((view,op)=>{try{return applyStoryOperation(view,op);}catch(error){if(!recoveryError)throw error;return previewRecoveredOperation(view,op,recoveryBase);}},confirmed);};rebuild();
  const status=()=>({pending:pending.length,error,durable,running:!!running,paused,synced:!pending.length && synced});
  const emit=()=>{
    for(const checkpoint of checkpoints){
      if(closed || paused || currentOwner()!==owner){checkpoints.delete(checkpoint);checkpoint.resolve(false);}
      else if(error){checkpoints.delete(checkpoint);checkpoint.reject(error);}
      else if(!pending.some(op=>checkpoint.ids.has(op.id))){checkpoints.delete(checkpoint);checkpoint.resolve(true);}
    }
    onChange(working,status());
  };
  const write=fn=>{journal=journal.then(fn).then(ok=>{if(ok===false){durable=false;emit();}}).catch(()=>{durable=false;emit();});return journal;};
  async function drain(whilePaused=false) {
    if(running)return running;
    if(closed || paused && !whilePaused || error || !pending.length || currentOwner()!==owner)return;
    running=(async()=>{
      await journal;
      while(pending.length && !closed && (!paused || whilePaused) && currentOwner()===owner && !error) {
        // An edit can arrive while the previous acknowledgement is being
        // journaled. Its own record must be durable before transport starts.
        await journal;
        if(closed || paused && !whilePaused || currentOwner()!==owner || error)break;
        const op=pending[0];
        try {
          const next=await commit(op,confirmed);
          // A successful transport may return an older, already committed receipt.
          // Replay its authoritative effect with known receipts, never revalidate
          // its captured source against a newer confirmed view after server success.
          const result={...next,...(Object.hasOwn(next,'replacement')?{message:next.replacement}:{})};
          receipts=[...receipts,{op,acknowledged:true,result}];
          confirmed=applyAcknowledgedOperations(receiptBase,receipts);
          pending=pending.slice(1);attempt=0;synced=true;
          await write(()=>storage.ack(owner,sid,op.id,confirmed,result));
          if(!pending.length){receiptBase=confirmed;receipts=[];recoveryError=null;recoveryBase=confirmed;}
          rebuild();emit();
        }catch(e){
          if(transient(e) && attempt<5 && !paused){const delay=Math.min(30000,1000*2**attempt++);timer=schedule(()=>{timer=null;void drain();},delay);break;}
          error=e;emit();break;
        }
      }
    })();
    try{await running;}finally{running=null;emit();}
  }
  return {
    get view(){return working;},get confirmed(){return confirmed;},get status(){return status();},
    enqueue(op){if(!pending.length)durable=true;if(closed)throw new Error('Story queue is closed.');if(paused)throw new Error('Wait for Sync to finish.');if(currentOwner()!==owner)throw new Error('Account changed.');const next=applyStoryOperation(working,op);pending=[...pending,op];working=next;write(()=>storage.put(owner,sid,op,confirmed));emit();void drain();return working;},
    async flush({whilePaused=false}={}){if(paused && !whilePaused)throw new Error('Wait for Sync to finish.');if(timer!==null){cancel(timer);timer=null;}error=null;attempt=0;await drain(whilePaused);if(pending.length)throw error ?? new Error('Changes not synced. Try again when connected.');},
    checkpoint(){
      if(paused || closed || currentOwner()!==owner)return Promise.resolve(false);
      if(error)return Promise.reject(error);
      if(!pending.length)return Promise.resolve(true);
      const promise=new Promise((resolve,reject)=>checkpoints.add({ids:new Set(pending.map(op=>op.id)),resolve,reject}));
      if(timer===null)void drain();return promise;
    },
    async pause(){paused=true;if(timer!==null){cancel(timer);timer=null;}emit();if(running)await running;await journal;},
    resume(){
      paused=false;
      if(error && transient(error) && attempt<5 && !closed){
        error=null;const delay=Math.min(30000,1000*2**attempt++);
        timer=schedule(()=>{timer=null;void drain();},delay);
      }
      emit();if(!error && timer===null)void drain();
    },
    retry(){if(paused || closed)return;if(timer!==null){cancel(timer);timer=null;}error=null;attempt=0;void drain();},
    async settled(){await journal;},
    start(){emit();void drain();},
    close(){closed=true;if(timer!==null)cancel(timer);emit();},
    cacheTurn(turn){receiptBase={...receiptBase,turns:{...receiptBase.turns,[turn.id]:turn}};confirmed={...confirmed,turns:{...confirmed.turns,[turn.id]:turn}};rebuild();emit();},
    adopt(base,{discardPending=false,serverConfirmed=false,notify=true}={}){if(discardPending && !paused)throw new Error('Pause saves before replacing local work.');if(pending.length && !discardPending)throw new Error('Sync pending changes first.');confirmed=base;working=base;receiptBase=base;receipts=[];if(discardPending){pending=[];error=null;recoveryError=null;attempt=0;durable=true;}if(serverConfirmed)synced=true;if(notify)emit();},
  };
}
