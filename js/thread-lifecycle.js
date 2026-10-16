import {parseStoryDate,parseClock,clockText} from './story-calendar.js';
export const THREAD_GRACE_MINUTES=3*24*60;
export const THREAD_OUTCOMES=['resolved','cancelled','expired-unresolved','background-unresolved'];
export function normalizeThreadMeta(value) {
  if(value==null)return null;
  if(typeof value!=='object' || Array.isArray(value))throw new Error('Invalid thread metadata.');
  const out={kind:value.kind ?? 'ongoing',dueDate:value.dueDate ?? null,dueTime:value.dueTime ?? null,participants:value.participants ?? [],location:value.location ?? null,outcome:value.outcome ?? null};
  if(!['appointment','commitment','ongoing'].includes(out.kind) || out.dueDate!==null && (typeof out.dueDate!=='string'||!parseStoryDate(out.dueDate)?.valid) || out.dueTime!==null && (typeof out.dueTime!=='string'||parseClock(out.dueTime)===null) || out.dueTime!==null && out.dueDate===null || !Array.isArray(out.participants) || out.participants.length>100 || out.participants.some(n=>typeof n!=='string'||!n.trim()||n.length>200) || out.location!==null && (typeof out.location!=='string'||out.location.length>300) || out.outcome!==null && !THREAD_OUTCOMES.includes(out.outcome))throw new Error('Invalid thread date, time, participants or outcome.');
  if(out.dueTime!==null)out.dueTime=clockText(parseClock(out.dueTime));
  return out;
}
// Conservative legacy adoption: one explicit date and clock in one scheduling
// statement. Relative dates, multiple candidates and incidental history stay unknown.
export function legacyThreadMeta(item) {
  if(item.threadTimingNeedsReview)return null;
  const texts=item.sections ? [item.sections.text?.text,...(item.sections.text?.lines ?? []).map(l=>l.text)] : [item.text];
  const candidates=[];
  for(const text of texts.filter(Boolean)) {
    if(text.includes('?') || /\b(?:proposed|suggested|invited|declined|refused|would|could|might|maybe|consider|considering|hypothetical|already|attended|completed|cancelled)\b/i.test(text))continue;
    if(!/\b(?:meet|meeting|appointment|date with|visit|promise|promised|deadline)\b/i.test(text))continue;
    const dates=[...text.matchAll(/(?<![\d/])\d{1,2}\/\d{1,2}\/\d{1,4}(?![\d/])/g)];
    const clocks=[...text.matchAll(/\b(?:\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m)\b/gi)];
    if(dates.length!==1 || clocks.length>1)continue;
    const clock=clocks[0]?.[0].replace(/^(\d{1,2})\s*([ap]m)$/i,'$1:00 $2');
    if(parseStoryDate(dates[0][0])?.valid && (!clock||parseClock(clock)!==null))candidates.push(normalizeThreadMeta({kind:/\b(?:appointment|meet|date with)\b/i.test(text)?'appointment':'commitment',dueDate:dates[0][0],dueTime:clock ?? null}));
  }
  return candidates.length===1?candidates[0]:null;
}
export function threadLifecycle(item,scene) {
  if(item.book && (item.book!=='events'||item.kind!=='thread'))return item;
  let meta;try{meta=normalizeThreadMeta(item.threadMeta) ?? legacyThreadMeta(item);}catch{return {...item,threadTimingNeedsReview:true};}
  if(!meta)return item;
  const result={...item,threadMeta:meta,...(meta.outcome?{status:meta.outcome==='cancelled'?'cancelled':'closed'}:{})};
  if(item.threadTimingNeedsReview || ['closed','cancelled'].includes(item.status) || meta.outcome)return result;
  const date=parseStoryDate(scene?.date ?? scene?.when),due=parseStoryDate(meta.dueDate);
  if(meta.kind==='ongoing'||!date?.valid||!due?.valid)return result;
  const time=parseClock(scene?.time ?? ''),scheduled=parseClock(meta.dueTime ?? '');
  // Unknown current precision only proves expiry once even the start of its day
  // has passed the deadline. Date-only appointments retain the entire due day.
  const now=date.ordinal*1440+(time ?? 0),expires=due.ordinal*1440+(scheduled ?? 1440)+THREAD_GRACE_MINUTES;
  return now>=expires ? {...result,status:'closed',threadMeta:{...meta,outcome:'expired-unresolved'},threadExpired:true} : result;
}
export function projectThreads(entries,scene){return entries.map(e=>threadLifecycle(e,scene));}
export function reopenThread(item) {
  const meta=normalizeThreadMeta(item.threadMeta);
  return {...item,status:'open',threadExpired:false,threadTimingNeedsReview:false,...(meta?{threadMeta:{...meta,outcome:null,...(['expired-unresolved','background-unresolved'].includes(meta.outcome)?{kind:'ongoing',dueDate:null,dueTime:null}:{})}}:{})};
}
export function threadSummary(item) {
  const m=item.threadMeta;if(!m)return '';
  return [m.outcome, m.dueDate && 'Scheduled '+m.dueDate+(m.dueTime?' '+m.dueTime:''),m.participants?.length?'With '+m.participants.join(', '):'',m.location].filter(Boolean).join(' · ');
}

export function threadIdentity(meta) {const m=normalizeThreadMeta(meta);return m?.dueDate && m.participants.length ? JSON.stringify([m.kind,parseStoryDate(m.dueDate).ordinal,m.dueTime,[...m.participants].map(n=>n.trim().toLowerCase()).sort(),m.location?.trim().toLowerCase() ?? '']) : null;}
