import {configureStorySync} from './story-sync.js';
import {createStoryQueue} from './story-queue.js';
import {operationId,applyStoryOperation} from './local-story.js';
import {requestSource} from './continuity.js';
import {storyQueueStorage,loadStoryData,saveStoryData} from './chat-cache.js';
import * as messages from './messages.js';
import {savePendingDirectorTurn,discardPendingDirector,getDirectorTurn} from './director-store.js';
import {currentUid} from './auth.js';
const stores=new Map(),opening=new Map();
const ownerNow=()=>{try{return currentUid();}catch{return null;}};
export function storyStore(sid){return stores.get(ownerNow()+':'+sid);}
export async function openStoryStore(sid,base,onChange){
  const key=currentUid()+':'+sid;
  if(opening.has(key)){const entry=await opening.get(key);entry.observe=onChange;onChange(entry.view,entry.status);return entry;}
  const pending=openStoryStoreImpl(sid,base,onChange);opening.set(key,pending);
  try{return await pending;}finally{opening.delete(key);}
}
async function openStoryStoreImpl(sid,base,onChange) {
  const owner=currentUid(),key=owner+':'+sid;
  const existing=stores.get(key);if(existing){existing.observe=onChange;onChange(existing.view,existing.status);existing.retry();return existing;}
  const [outbox,aux]=await Promise.all([storyQueueStorage.load(owner,sid),loadStoryData(owner,sid)]);
  if(currentUid()!==owner)throw new Error('Account changed.');
  let recovered=outbox?.base ?? aux?.confirmed;
  let operations=outbox?.operations ?? [];
  if(outbox?.records){let unacknowledged=false;for(const record of outbox.records){if(!record.acknowledged)unacknowledged=true;if(unacknowledged){operations.push(record.op);continue;}recovered=applyStoryOperation(recovered,record.op);if(record.result?.session)recovered.session=record.result.session;if(record.result?.message)recovered.messages=recovered.messages.map(m=>m.id===record.result.message.id?record.result.message:m);}}

  if(recovered && (outbox || !base || (recovered.session.historyRevision ?? 0)>(base.session.historyRevision ?? 0)))base=recovered;
  if(!base)throw new Error('Story history has not loaded.');
  base={...base,turns:{...aux?.turns,...base.turns}};
  await messages.restoreMessageChunkCache?.(sid,base.messages);
  let entry;
  const queue=createStoryQueue({owner,sid,base,operations,storage:storyQueueStorage,currentOwner:ownerNow,onChange:(view,status)=>entry?.observe?.(view,status),commit:async(op,confirmed)=>{
    if(currentUid()!==owner)throw new Error('Account changed.');
    const p=op.payload,options={operationId:op.id,session:confirmed.session,expectedSource:op.source};
    switch(op.kind){
      case 'add':return messages.addMessage(sid,p.message,{...options,id:p.id,sessionUpdate:p.sessionUpdate ?? {}});
      case 'edit':return messages.editMessage(sid,p.id,p.content,p.order,{...options,expectedRevision:p.expectedRevision});
      case 'delete':return messages.deleteMessage(sid,p.id,p.order,options);
      case 'overwrite':return messages.overwriteMessage(sid,p.id,p.message,p.order,{},op.source,options);
      case 'director':await savePendingDirectorTurn(sid,p.turn,op.source,options);return {};
      case 'discardDirector':await discardPendingDirector(sid,op.source,options);return {};
      default:throw new Error('Unsupported local story operation.');
    }
  }});
  entry={observe:onChange,get confirmed(){return queue.confirmed;},get view(){return queue.view;},get status(){return queue.status;},enqueue(kind,payload){return queue.enqueue({id:operationId(),kind,payload,source:requestSource(queue.view.session),createdAt:Date.now()});},flush:()=>queue.flush(),adopt:(base,{persist=true}={})=>{queue.adopt(base);if(persist)void saveStoryData(owner,sid,{confirmed:base});},retry:()=>queue.retry(),close:()=>queue.close(),settled:()=>queue.settled(),
    async getTurn(_sid,id){if(queue.view.turns[id])return queue.view.turns[id];const turn=await getDirectorTurn(sid,id);if(currentUid()!==owner)throw new Error('Account changed.');if(turn){queue.cacheTurn(turn);await saveStoryData(owner,sid,{turns:queue.view.turns});}return turn;},
    saveTurn(_sid,turn){const view=entry.enqueue('director',{turn});return Promise.resolve(view.turns[turn.id]);},
  };
  stores.set(key,entry);
  const idle=[...stores].filter(([other,value])=>other.startsWith(owner+':') && !value.status.pending && other!==key);
  for(const [other,value]of idle.slice(0,Math.max(0,idle.length-2))){value.close();stores.delete(other);}
  queue.start();return entry;
}
export async function flushStory(sid){if(!sid)return;let store=storyStore(sid);if(!store){const owner=ownerNow();if(!owner)return;const outbox=await storyQueueStorage.load(owner,sid);if(!outbox)return;store=await openStoryStore(sid,outbox.base,()=>{});}await store.flush();}
export function forgetStoryStore(sid){const key=ownerNow()+':'+sid,entry=stores.get(key);if(entry?.status.pending)return;entry?.close();stores.delete(key);}
export function closeStoryStores(){for(const entry of stores.values())entry.observe=null;}

configureStorySync(sid=>flushStory(sid));
