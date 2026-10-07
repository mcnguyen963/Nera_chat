export function createBusyGate({current,onChange,onRelease}) {
  let active=null,sequence=0;
  return {acquire(kind){if(active)return null;const c=current();if(!c.sid)return null;active={...c,id:++sequence,kind};onChange(true);return active;},
    release(token){if(!token || active!==token)return false;active=null;onChange(false);onRelease?.();return true;},
    stillActive(token){const c=current();return !!token && active===token && token.sid===c.sid && token.epoch===c.epoch && token.owner===c.owner;},
    get active(){return active;}};
}
export function bridgeHistory(base,revision,message) {
  if(!base || revision!==message.historyRevision-1)return null;
  const map=new Map(base.map(m=>[m.id,m]));map.set(message.id,message);return [...map.values()].sort((a,b)=>a.order-b.order);
}
