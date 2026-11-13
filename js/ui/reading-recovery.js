import {captureListPosition} from './scroll-position.js';

const PREFIX='nera.reading-position.v1:';
const valid=p=>p && typeof p.story==='string' && typeof p.sticky==='boolean' &&
  (p.sticky || typeof p.id==='string' && p.id.length<=512 && Number.isFinite(p.order) && Number.isFinite(p.offset) && Math.abs(p.offset)<=1e7);

// Only small anchors are persisted. No message text, snapshots or DOM nodes.
export function createReadingPositionStore({storage=()=>globalThis.localStorage}={}) {
  const key=owner=>PREFIX+encodeURIComponent(owner);
  function readAll(owner) {
    try { const rows=JSON.parse(storage()?.getItem(key(owner)) ?? '[]');return Array.isArray(rows) ? rows.filter(valid).slice(0,20) : []; }
    catch {return [];}
  }
  return {
    read(owner,story){return owner && story ? readAll(owner).find(p=>p.story===story) ?? null : null;},
    write(owner,story,position){
      if(!owner || !story)return;
      const entry={story,...position};if(!valid(entry))return;
      try {storage()?.setItem(key(owner),JSON.stringify([entry,...readAll(owner).filter(p=>p.story!==story)].slice(0,20)));}catch {/* Reading recovery is optional when device storage is unavailable. */}
    },
    clearStory(owner,story){
      if(!owner || !story)return;
      try {storage()?.setItem(key(owner),JSON.stringify(readAll(owner).filter(p=>p.story!==story)));}catch { /* Best effort device preference. */ }
    },
    clearAccount(owner){if(owner)try {storage()?.removeItem(key(owner));}catch { /* Best effort device preference. */ }},
  };
}

export function createReadingRecovery({list,current,messages,store=createReadingPositionStore(),doc=document,win=window,schedule=setTimeout,cancel=clearTimeout}) {
  let scope=null,pending=null,timer=null;
  const stop=()=>{if(timer!==null)cancel(timer);timer=null;};
  const context=()=>{try {return current();}catch {return null;}};
  function flush() {
    stop();if(!scope || pending)return;const live=context();
    if(!live?.ready || live.owner!==scope.owner || live.sid!==scope.sid)return;
    const position=captureListPosition(list),message=messages().find(m=>m.id===position.id);
    if(!position.sticky && !message)return;
    store.write(scope.owner,scope.sid,{sticky:position.sticky,id:message?.id ?? null,order:message?.order ?? null,
      offset:position.sticky ? 0 : position.top-list.getBoundingClientRect().top});
  }
  list.addEventListener('scroll',()=>{stop();timer=schedule(flush,200);},{passive:true});
  win.addEventListener('pagehide',flush);
  doc.addEventListener('visibilitychange',()=>{if(doc.hidden)flush();});
  return {
    open(owner,sid){flush();scope=owner && sid ? {owner,sid} : null;pending=store.read(owner,sid);},
    beforeRender(rows,{complete=false}={}) {
      if(!pending || !rows.length && !complete)return null;
      const live=context();if(!scope || !live || live.owner!==scope.owner || live.sid!==scope.sid)return null;
      let index=pending.sticky ? -1 : rows.findIndex(m=>m.id===pending.id);
      if(!pending.sticky && index<0){
        if(!complete)return null;
        // Deleted anchors resume at the next surviving message, or the end.
        index=rows.findIndex(m=>m.order>=pending.order);if(index<0)index=rows.length-1;
      }
      const saved=pending;pending=null;
      return {count:index<0 ? 0 : rows.length-index,
        position:{sticky:saved.sticky || index<0,id:rows[index]?.id,offset:saved.offset}};
    },
    clearStory(owner,sid){store.clearStory(owner,sid);if(scope?.owner===owner && scope.sid===sid){stop();scope=pending=null;}},
    clearAccount(owner){store.clearAccount(owner);if(scope?.owner===owner){stop();scope=pending=null;}},
  };
}
