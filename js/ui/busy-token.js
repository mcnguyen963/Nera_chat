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

// Stop must release reply preparation even if a storage read or tokenizer hangs.
export async function waitForPreparation(promise, controller, timeoutMs = 120000) {
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error(controller.signal.reason === 'timeout'
      ? 'Reply preparation stopped responding (120 s). Try Retry reply.' : 'Stopped.'), { name:'AbortError' }));
    if (controller.signal.aborted) abort();
    else {
      controller.signal.addEventListener('abort', abort, { once:true });
      timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
      timer?.unref?.();
    }
  });
  try { return await Promise.race([promise, stopped]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
}
