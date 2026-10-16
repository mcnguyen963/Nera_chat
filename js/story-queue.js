// Ordered, durable, per-story outbox. Persistence and transport are injected.
import { applyStoryOperation } from './local-story.js';
const transient=e=>['unavailable','deadline-exceeded','aborted','resource-exhausted','internal','network-request-failed'].includes(String(e.code ?? '').replace('firestore/','')) || e instanceof TypeError;
export function createStoryQueue({owner,sid,base,operations=[],storage,commit,currentOwner,onChange=()=>{},schedule=setTimeout,cancel=clearTimeout}) {
  let confirmed=base, pending=operations,working=base,error=null,running=null,timer=null,closed=false,attempt=0,durable=true;
  let journal=Promise.resolve();
  const rebuild=()=>{working=pending.reduce(applyStoryOperation,confirmed);};rebuild();
  const status=()=>({pending:pending.length,error,durable,running:!!running});
  const emit=()=>onChange(working,status());
  const write=fn=>{journal=journal.then(fn).then(ok=>{if(ok===false){durable=false;emit();}}).catch(()=>{durable=false;emit();});return journal;};
  async function drain() {
    if(running)return running;
    if(closed || error || !pending.length || currentOwner()!==owner)return;
    running=(async()=>{
      await journal;
      while(pending.length && !closed && currentOwner()===owner && !error) {
        // An edit can arrive while the previous acknowledgement is being
        // journaled. Its own record must be durable before transport starts.
        await journal;
        if(closed || currentOwner()!==owner || error)break;
        const op=pending[0];
        try {
          const next=await commit(op,confirmed);
          // Apply the semantic mutation, then authoritative metadata from its receipt.
          confirmed=applyStoryOperation(confirmed,op);
          if(next.session)confirmed={...confirmed,session:next.session};
          if(next.message || next.replacement){const m=next.message ?? next.replacement;confirmed={...confirmed,messages:confirmed.messages.map(x=>x.id===m.id?m:x)};}
          pending=pending.slice(1);attempt=0;
          await write(()=>storage.ack(owner,sid,op.id,confirmed));
          rebuild();emit();
        }catch(e){
          if(transient(e) && attempt<5){const delay=Math.min(30000,1000*2**attempt++);timer=schedule(()=>{timer=null;void drain();},delay);break;}
          error=e;emit();break;
        }
      }
    })();
    try{await running;}finally{running=null;emit();}
  }
  return {
    get view(){return working;},get confirmed(){return confirmed;},get status(){return status();},
    enqueue(op){if(!pending.length)durable=true;if(closed)throw new Error('Story queue is closed.');if(currentOwner()!==owner)throw new Error('Account changed.');const next=applyStoryOperation(working,op);pending=[...pending,op];working=next;write(()=>storage.put(owner,sid,op,confirmed));emit();void drain();return working;},
    async flush(){if(timer!==null){cancel(timer);timer=null;}error=null;attempt=0;await drain();if(pending.length)throw error ?? new Error('Changes not synced. Try again when connected.');},
    retry(){if(timer!==null){cancel(timer);timer=null;}error=null;attempt=0;void drain();},
    async settled(){await journal;},
    start(){emit();void drain();},
    close(){closed=true;if(timer!==null)cancel(timer);},
    cacheTurn(turn){confirmed={...confirmed,turns:{...confirmed.turns,[turn.id]:turn}};rebuild();emit();},
    adopt(base){if(pending.length)throw new Error('Sync pending changes first.');confirmed=base;working=base;emit();},
  };
}
