// Pure working-copy reducer. Firebase metadata is kept separately by the queue.
import { canonicalScene } from './scene.js';
import { requestSource, assertSource, trimInvalidations } from './continuity.js';
import { summaryLookup } from './message-chunks.js';
export const operationId = () => 'op_'+Date.now().toString(36)+'_'+globalThis.crypto.randomUUID();
const copy = value => structuredClone(value);
export function applyStoryOperation(base, op) {
  if(!['add','edit','delete','overwrite','director','discardDirector'].includes(op.kind) || !op.id || !op.payload)throw new Error('Unsupported local story operation.');
  const view={session:{...base.session},messages:base.messages,turns:{...base.turns}};
  const s=view.session, p=op.payload;
  if(op.source)assertSource(s,op.source);
  if(op.kind==='director') {
    const turn={...p.turn,version:1,status:'pending',source:requestSource(s)};
    view.turns[turn.id]=turn;s.directorPending=turn.id;return view;
  }
  if(op.kind==='discardDirector') {if(s.directorPending && view.turns[s.directorPending])view.turns[s.directorPending]={...view.turns[s.directorPending],status:'discarded'};s.directorAbandonedTurnIds=[...(s.directorAbandonedTurnIds ?? []),...(s.directorPending?[s.directorPending]:[])].slice(-200);s.directorPending=null;s.directorRevision=(s.directorRevision ?? 0)+1;return view;}
  if(op.kind==='add') {
    if(s.directorPending && p.message.role==='user')throw new Error('Discard the pending Director contract first.');
    const order=(s.nextOrder ?? 0)+1;
    const m={...p.message,id:p.id,order,revision:0,narratorTurn:s.nextNarratorTurn ?? 1,tokenCount:p.message.tokenCount ?? 0,createdAt:p.message.createdAt ?? op.createdAt};
    view.messages=[...view.messages,m];s.nextOrder=order;s.nextNarratorTurn=(s.nextNarratorTurn ?? 1)+(m.role==='assistant'?1:0);
    Object.assign(s,p.sessionUpdate ?? {});completeDirector(view,m);s.historyRevision=(s.historyRevision ?? 0)+1;Object.assign(s,summaryLookup(view.messages));return view;
  }
  const current=view.messages.find(m=>m.id===p.id);
  if(!current)throw new Error('Message not found in the local history.');
  if(p.expectedRevision!=null && (current.revision ?? 0)!==p.expectedRevision)throw new Error('The message changed. Reopen the editor.');
  const overwrite=op.kind==='overwrite';
  if(overwrite && (current.role!=='assistant' || view.messages.some(m=>m.role!=='summary' && m.order>current.order)))throw new Error('Only the latest reply can be replaced.');
  let replacement=op.kind==='delete'?null:{...current,...p.message};
  if(op.kind==='edit')replacement={...replacement,content:p.content,tokenCount:p.tokenCount ?? current.tokenCount,lastContinuation:null,truncated:false,reviewWarnings:[],editedAt:op.createdAt,...(current.acceptance==='pending'?{scene:current.sceneCandidate?.scene ?? current.scene,sceneMeta:current.sceneCandidate?.sceneMeta ?? current.sceneMeta,sceneCandidate:null,acceptance:'accepted'}:{})};
  const changed=!replacement || replacement.content!==current.content || canonicalScene(replacement.scene)!==canonicalScene(current.scene) || JSON.stringify(replacement.sceneMeta ?? null)!==JSON.stringify(current.sceneMeta ?? null);
  if(replacement)replacement={...replacement,revision:(current.revision ?? 0)+(changed?1:0)};
  let messages=view.messages.flatMap(m=>m.id===p.id?(replacement?[replacement]:[]):[m]);
  const reset=!!s.activeSummaryMessageId && changed && (current.role!=='summary' && current.order<=(s.breakpointOrder ?? 0) || !replacement && current.id===s.activeSummaryMessageId);
  if(reset) {
    const fallback=messages.filter(m=>{const end=m.coveredRange?.toOrder ?? m.coveredRange?.to,start=m.coveredRange?.fromOrder ?? m.coveredRange?.from;return m.role==='summary' && !m.retired && m.id!==p.id && m.content?.trim() && Number.isSafeInteger(end) && end>0 && end<current.order && end<m.order && (start==null || Number.isSafeInteger(start) && start>=0 && start<=end);}).sort((a,b)=>b.order-a.order)[0];
    s.activeSummaryMessageId=fallback?.id ?? null;s.breakpointOrder=fallback?.coveredRange?.toOrder ?? fallback?.coveredRange?.to ?? 0;
  }
  if(reset || changed && current.role!=='summary')messages=messages.map(m=>m.role==='summary' && !m.retired && (m.id===(reset?base.session.activeSummaryMessageId:null) || (m.coveredRange?.toOrder ?? m.coveredRange?.to ?? Infinity)>=current.order)?{...m,retired:true}:m);
  const lastAssistantDeleted=!replacement && current.role==='assistant' && !messages.some(m=>['assistant','user'].includes(m.role) && m.order>current.order);
  let rollback=false;
  if(lastAssistantDeleted) {
    s.nextNarratorTurn=current.narratorTurn;
    let turn=view.turns[current.directorTurnId];
    if(current.directorTurnId && s.directorCheckpoint===current.directorTurnId && !turn)throw new Error('Load the Director checkpoint before deleting this reply.');
    if(turn && s.directorCheckpoint===turn.id){let previous=turn.previousCheckpoint ?? null,steps=0;while(previous && steps++<100){const prior=view.turns[previous];if(!prior)throw new Error('Load the Director checkpoint chain before deleting this reply.');if(prior.assistantId!==current.id)break;turn=prior;previous=prior.previousCheckpoint ?? null;}Object.assign(s,{directorState:turn.before,directorCheckpoint:previous,directorStateHistoryOrder:Math.max(0,current.order-1),directorPending:null,directorRevision:(s.directorRevision ?? 0)+1});rollback=true;}
  }
  if(!overwrite && changed && current.role!=='summary' && s.directorState && !rollback)Object.assign(s,{directorNeedsReview:true,directorPending:null,directorRevision:(s.directorRevision ?? 0)+1});
  view.messages=messages;
  if(overwrite)completeDirector(view,replacement);
  s.historyRevision=(s.historyRevision ?? 0)+1;
  const pointer=s.memoryState?.extractedThroughOrder;
  if(changed && current.role!=='summary' && pointer!=null){const edits=[...(s.contentEdits ?? []),{order:current.order,revision:s.historyRevision}];s.contentEdits=edits.slice(-20);if(edits.length>20)s.contentEditsFloor=Math.max(s.contentEditsFloor ?? 0,...edits.slice(0,-20).map(e=>e.revision));if(current.order<=pointer){s.memoryInvalidations=trimInvalidations([...(s.memoryInvalidations ?? []),{fromOrder:current.order,toOrder:pointer,revision:s.historyRevision}]);s.memoryState={...s.memoryState,needsRebuild:true,rebuildFromOrder:Math.min(s.memoryState?.rebuildFromOrder ?? Infinity,current.order)};}}
  view.messages=messages;
  Object.assign(s,summaryLookup(messages));return view;
}
function completeDirector(view,m,advance=1) {
  if(!m.directorTurnId)return;
  const s=view.session,turn=view.turns[m.directorTurnId];
  if(!turn || turn.status==='discarded')throw new Error('Director contract is missing or discarded.');
  const rewrite=turn.status==='completed' && s.directorCheckpoint===turn.id;
  if(!rewrite){if(s.directorPending!==turn.id)throw new Error('The pending Director contract changed.');assertSource(s,turn.source);}
  if(!m.truncated && !rewrite)Object.assign(s,{directorState:copy(turn.after),directorRevision:(s.directorRevision ?? 0)+1,directorCheckpoint:turn.id,directorPending:null,directorNeedsReview:false,directorStateHistoryOrder:m.order});
  view.turns[turn.id]={...turn,status:m.truncated?'pending':'completed',assistantId:m.id,order:m.order,source:requestSource({...s,historyRevision:(s.historyRevision ?? 0)+advance})};
}

// Receipts can arrive from independent tabs in a different order from journal
// insertion. Replay only confirmed effects, retaining the newest server metadata.
export function applyAcknowledgedOperations(base,records) {
  const compare=(a,b)=>{for(const field of ['historyRevision','directorRevision','storySettingsRevision','loreRevision']){const delta=(a?.[field] ?? 0)-(b?.[field] ?? 0);if(delta)return delta;}return 0;};
  const sequence=record=>record.result?.session ?? {...record.op.source,directorRevision:(record.op.source?.directorRevision ?? 0)+(record.op.kind==='discardDirector'?1:0)};
  for(const record of [...records].sort((a,b)=>compare(sequence(a),sequence(b)) || Number(!a.result?.session)-Number(!b.result?.session))){
    const {op,result={}}=record,prior=base;
    try{base=applyStoryOperation(base,{...op,source:null,payload:{...op.payload,expectedRevision:null}});}catch{
      // A confirmed older edit/delete may already be superseded in queueBase.
      // Its authoritative receipt still supplies the message and session below.
      base={...base,session:{...base.session},turns:{...base.turns}};
    }
    if(compare(result.session,prior.session)>=0 && result.session)base.session=result.session;
    else if(result.session)base.session=prior.session;
    if(Object.hasOwn(result,'message')){
      const message=result.message,current=prior.messages.find(m=>m.id===op.payload.id);
      if(message){
        const chosen=current && (current.revision ?? 0)>(message.revision ?? 0)?current:message;
        let replaced=false;
        base.messages=base.messages.flatMap(message=>{if(message.id!==chosen.id)return [message];if(replaced)return [];replaced=true;return [chosen];});
        if(!replaced)base.messages=[...base.messages,chosen].sort((a,b)=>a.order-b.order);
      }else if(['edit','delete','overwrite','add'].includes(op.kind))base.messages=base.messages.filter(m=>m.id!==op.payload.id);
    }
    // Only turn records affected by this operation may replace existing state.
    for(const [id,turn]of Object.entries(base.turns))if(turn!==prior.turns[id] && result.turns?.[id])base.turns[id]=result.turns[id];
  }
  return base;
}

// A recovered conflict keeps its local text visible/exportable while transport
// retains the original provenance checks. This preview never authorizes a save.
export function previewRecoveredOperation(base,op,original) {
  const preview={...op,source:null,payload:{...op.payload,expectedRevision:null}};
  try{return applyStoryOperation(base,preview);}catch{
    const p=op.payload;
    if(['edit','overwrite'].includes(op.kind)){
      const previous=base.messages.find(m=>m.id===p.id) ?? original.messages.find(m=>m.id===p.id);
      if(previous){const message={...previous,...p.message,...(op.kind==='edit'?{content:p.content}:{})};return {...base,messages:[...base.messages.filter(m=>m.id!==p.id),message].sort((a,b)=>a.order-b.order)};}
    }
    if(op.kind==='delete')return {...base,messages:base.messages.filter(m=>m.id!==p.id)};
    if(op.kind==='add')return {...base,messages:[...base.messages,{...p.message,id:p.id,order:(base.session.nextOrder ?? 0)+1}]};
    return base;
  }
}
