// Dialogs may close while saving; dependent generation waits without locking UI.
const pending=new Map();
const key=(owner,sid)=>JSON.stringify([owner,sid ?? null]);
export function beginSettingsSave(owner,sid=null) {
  const id=key(owner,sid);let finish;
  const promise=new Promise((resolve,reject)=>finish=ok=>ok?resolve():reject(new Error('Settings were not saved. Review settings before sending.')));
  promise.catch(()=>{});pending.set(id,promise);
  return ok=>{if(pending.get(id)===promise)pending.delete(id);finish(ok);};
}
export function hasPendingSettings(owner,sid){return pending.has(key(owner,null)) || pending.has(key(owner,sid));}
export async function waitForPendingSettings(owner,sid) {
  while(hasPendingSettings(owner,sid))await Promise.all([pending.get(key(owner,null)),pending.get(key(owner,sid))]);
}
