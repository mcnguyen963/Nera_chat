// Offsets refer to JavaScript string boundaries; no narrative is duplicated.
const stateKeys=['scene','sceneMeta','planThread','ooc','truncated','acceptance','reviewWarnings','sceneCandidate','responseDiagnostics'];
export function continuationTarget(session,messages,id) {
  const latest=messages.filter(m=>['user','assistant'].includes(m.role)).sort((a,b)=>a.order-b.order).at(-1);
  if (!latest || latest.role!=='assistant' || (id && latest.id!==id) || latest.order<=(session.breakpointOrder ?? 0)) throw new Error('Continue requires the latest assistant reply above the summary checkpoint.');
  return latest;
}
export function continuationPrefix(message) {
  const c=message.lastContinuation;
  if (!c || !Number.isInteger(c.contentOffset) || c.contentOffset<=0 || c.contentOffset>=message.content.length || message.content.slice(c.contentOffset,c.contentOffset+2)!=='\n\n' || !Number.isInteger(c.thinkingOffset) || c.thinkingOffset<0 || c.thinkingOffset>(message.thinking ?? '').length || !c.before || typeof c.before!=='object' || stateKeys.some(k=>!Object.hasOwn(c.before,k))) throw new Error('The latest continuation checkpoint is malformed. Edit the reply to clear it before regenerating.');
  const nullable=(value,type)=>value==null || typeof value===type;
  if(!nullable(c.before.scene,'string') || !nullable(c.before.planThread,'string') || !nullable(c.before.ooc,'boolean') || !nullable(c.before.truncated,'boolean') || !nullable(c.before.acceptance,'string') || (c.before.reviewWarnings!=null && (!Array.isArray(c.before.reviewWarnings) || c.before.reviewWarnings.some(w=>typeof w!=='string'))) || ['sceneMeta','sceneCandidate','responseDiagnostics'].some(k=>c.before[k]!=null && (typeof c.before[k]!=='object' || Array.isArray(c.before[k]))))throw new Error('The latest continuation checkpoint is malformed. Edit the reply to clear it before regenerating.');
  const before=Object.fromEntries(stateKeys.map(k=>[k,structuredClone(c.before[k])]));
  return {...message,...before,content:message.content.slice(0,c.contentOffset),thinking:(message.thinking ?? '').slice(0,c.thinkingOffset),lastContinuation:null};
}
export function appendContinuation(prefix,passage) {
  const before=Object.fromEntries(stateKeys.map(k=>[k,structuredClone(prefix[k] ?? null)]));
  return {...passage,content:prefix.content+'\n\n'+passage.content,thinking:(prefix.thinking ?? '')+(passage.thinking ? '\n\n'+passage.thinking : ''),truncated:!!(prefix.truncated || passage.truncated),lastContinuation:{contentOffset:prefix.content.length,thinkingOffset:(prefix.thinking ?? '').length,before}};
}
