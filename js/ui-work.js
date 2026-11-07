// Yield actual tasks, not just resolved promises, so input and painting can run.
/** @param {{signal?: AbortSignal, check?:()=>void, budget?:number, now?:()=>number, yieldTask?:()=>Promise<void>}} [options] */
export function createWorkBudget({signal, check=()=>{}, budget=8,
  now=()=>globalThis.performance?.now?.() ?? Date.now(),
  yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0))}={}) {
  let deadline=now()+budget;
  const assert=()=>{signal?.throwIfAborted();check();};
  return async ()=>{
    assert();
    if(now()<deadline)return;
    await yieldTask(); assert(); deadline=now()+budget;
  };
}
export function afterUiPaint() {
  return new Promise(resolve=>{
    if(typeof requestAnimationFrame==='function' && !globalThis.document?.hidden)
      requestAnimationFrame(()=>setTimeout(resolve,0));
    else setTimeout(resolve,0);
  });
}
