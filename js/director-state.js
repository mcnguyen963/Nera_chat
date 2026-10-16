import { normalizeName } from './lore-lines.js';
import { latestScene, parseScene, sceneLine } from './scene.js';
import {normalizeThreadMeta,threadLifecycle,threadIdentity} from './thread-lifecycle.js';
import { parseStoryDate, parseClock, clockText } from './story-calendar.js';
export const DIRECTOR_VERSION = 2;
const groups = ['decisions','threads','commitments'];
const statuses = ['open','active','waiting','ready','closed','cancelled'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 2000) => typeof value === 'string' && value.length <= max;
const fail = message => { throw new Error('Director: '+message); };
export function playerStopBoundary(input) {
  const text=String(input ?? '').replace(/"[^"]*"|“[^”]*”/g,'');
  const start='(?:^|[.!?;]\\s*|\\band\\s+)stop\\s+';
  return new RegExp(start+'(?:(?:when|once|as soon as)\\s+(?:we|i|you|they)\\s+arrive|(?:on|upon|at)\\s+arrival)\\b','i').test(text)
    ? {kind:'arrival',instruction:'End at destination arrival before any follow-on conversation, offer, registration or activity; a genuine interruption may stop the journey earlier for a player response.'} : null;
}
export function assertDirectorBoundary(turn, boundary) {
  if(boundary?.kind==='arrival' && turn.contract.action==='narrate' && turn.contract.transition==='completed' && turn.after.decisions.some(i=>!turn.before.decisions.some(old=>old.id===i.id)))fail('planned a new player decision beyond the requested arrival boundary. Retry or Re-plan before narration.');
}
export function validateDirectorState(value) {
  if (!object(value) || ![1,DIRECTOR_VERSION].includes(value.version)) fail('unsupported live-state version.');
  const s = structuredClone(value), scene = s.scene;
  if (!object(scene) || !(scene.date === null || text(scene.date,100)) || !(s.version===1 ? scene.hour===null || Number.isInteger(scene.hour) && scene.hour>=1 && scene.hour<=24 : scene.time===null || typeof scene.time==='string' && parseClock(scene.time)!==null) || !(scene.location === null || text(scene.location,300)) || !Array.isArray(scene.present) || scene.present.length > 100 || scene.present.some(n=>!text(n,200) || !n.trim())) fail(s.version===1?'invalid scene; use game hours 1–24.':'invalid scene; use modern time HH:mm or unknown.');
  if(s.version===2 && scene.time!==null)scene.time=clockText(parseClock(scene.time));
  if(s.version===2 && Object.hasOwn(scene,'hour'))fail('modern scene must use time, not game hour.');
  if (scene.date && !parseStoryDate(scene.date)?.valid) fail('date must be day/month/year or unknown.');
  if (!(s.event === null || object(s.event) && text(s.event.id,200) && text(s.event.name,300) && text(s.event.phase,1000))) fail('invalid event.');
  for (const group of groups) {
    if (!Array.isArray(s[group]) || s[group].length > 200) fail('invalid '+group+' ledger.');
    const ids = new Set();
    for (const item of s[group]) {
      if (!object(item) || !text(item.id,200) || !item.id.trim() || ids.has(item.id) || !text(item.text) || !item.text.trim() || !statuses.includes(item.status) || !(item.trigger === undefined || text(item.trigger)) || !(item.source === undefined || text(item.source,500))) fail('invalid '+group+' item.');
      if(item.threadMeta!=null)item.threadMeta=normalizeThreadMeta(item.threadMeta);
      ids.add(item.id);
    }
  }
  if(s.archive!==undefined && (!Array.isArray(s.archive)||s.archive.length>200||s.archive.some(i=>!object(i)||!groups.includes(i.group)||!text(i.id,200)||!text(i.text)||!['closed','cancelled'].includes(i.status))))fail('invalid thread archive.');
  for(const item of s.archive ?? [])if(item.threadMeta!=null)item.threadMeta=normalizeThreadMeta(item.threadMeta);
  if (JSON.stringify(s).length > 120000) fail('live state is too large. Close completed items before continuing.');
  return s;
}
export function directorScene(state) {
  const s = validateDirectorState(state).scene;
  return sceneLine({when:s.date,time:state.version===2 ? s.time : s.hour === null ? null : 'Hour '+s.hour,place:s.location,present:s.present});
}
export function seedDirectorState(session, messages, entries = []) {
  const saved = latestScene(messages,Infinity,session.memory?.startingScene).scene;
  const date = saved?.when && parseStoryDate(saved.when)?.valid ? saved.when : null;
  const match = saved?.time?.match(/^(?:hour\s*)?(\d{1,2})$/i);
  const hour = match && Number(match[1]) >= 1 && Number(match[1]) <= 24 ? Number(match[1]) : null;
  const modern=parseClock(saved?.time ?? '');
  const version=hour!==null?1:2;
  return validateDirectorState({version,scene:{date,...(version===1?{hour}:{time:modern===null?null:clockText(modern)}),location:saved?.place ?? null,present:saved?.present ?? []},event:null,decisions:[],commitments:[],threads:entries.filter(e=>e.book==='events' && e.kind==='thread' && e.status!=='closed').map(e=>({id:'lore:'+e.id,text:e.name,status:'open',source:e.id,trigger:'',...(e.threadMeta?{threadMeta:e.threadMeta}:{})}))});
}
export function directorClockNeedsReview(session,messages,state,upToOrder=Infinity) {
  if(state.version===2)return null;
  return state.scene.hour!==null ? 'Hour '+state.scene.hour : latestScene(messages,upToOrder,session.memory?.startingScene).scene?.time ?? 'unknown legacy clock';
}
export function modernizeDirectorState(state,date,time) {
  const next=structuredClone(state);next.version=2;next.scene={date,time,location:next.scene.location,present:next.scene.present};
  return validateDirectorState(next);
}
export function settleDirectorState(state) {
  const result=validateDirectorState(state);
  const archive=[...(result.archive ?? [])];
  for(const group of groups) {
    result[group]=result[group].map(item=>group==='decisions'?item:threadLifecycle(item,result.scene));
    for(const item of result[group].filter(i=>['closed','cancelled'].includes(i.status))) {
      if(result.version===2)archive.push({...item,...(group!=='decisions'?{threadMeta:normalizeThreadMeta({...item.threadMeta,outcome:item.threadMeta?.outcome ?? (item.status==='cancelled'?'cancelled':'resolved')})}:{}),group,closedAt:{date:result.scene.date,time:result.scene.time}});
    }
    result[group]=result[group].filter(i=>!['closed','cancelled'].includes(i.status));
  }
  if(result.version===2 && archive.length)result.archive=[...new Map(archive.map(i=>[i.group+':'+i.id,i])).values()].slice(-200);
  return validateDirectorState(result);
}
export function parseDirectorContract(content, before, entries = [], {protagonist='',focusLimit=5,allowedMemoryIds}={}) {
  let raw;
  try { raw = JSON.parse(String(content).trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i,'$1')); } catch { fail('returned invalid JSON. Retry or change the Director model.'); }
  if (!object(raw) || raw.version!==1 || !['narrate','answer','wait'].includes(raw.action) || !text(raw.objective,4000) || !raw.objective.trim() || !text(raw.stopCondition,2000) || !raw.stopCondition.trim() || !['attempted','blocked','completed','unchanged'].includes(raw.transition) || !Array.isArray(raw.memoryIds) || raw.memoryIds.length>100 || !Array.isArray(raw.requiredMemoryIds) || raw.requiredMemoryIds.length>100 || !object(raw.updates)) fail('invalid turn contract.');
  if (JSON.stringify(raw).length>60000) fail('turn contract is too large.');
  // Ignore unrecognized top-level fields rather than forwarding a second,
  // unvalidated state or ledger to the Narrator alongside canonical updates.
  raw=Object.fromEntries(['version','action','transition','objective','stopCondition','memoryIds','requiredMemoryIds','updates',...['focusCharacterIds','encounterCharacterIds'].filter(k=>Object.hasOwn(raw,k))].map(key=>[key,raw[key]]));
  // Essential cards are necessarily selected; omission from the optional list
  // does not change their meaning or authorize an unknown reference.
  raw.memoryIds=[...new Set([...raw.memoryIds,...raw.requiredMemoryIds])];
  raw.requiredMemoryIds=[...new Set(raw.requiredMemoryIds)];
  if(raw.memoryIds.length>100)fail('too many selected memory cards.');
  const known = new Set(entries.filter(e=>!allowedMemoryIds || allowedMemoryIds.includes(e.id)).map(e=>e.id));
  if (raw.memoryIds.some(id=>!known.has(id))) fail('contract references unknown memory cards.');
  let after = validateDirectorState(before);
  const allowed = new Set(['scene','event',...groups]);
  if (Object.keys(raw.updates).some(k=>!allowed.has(k))) fail('unknown state update.');
  if(raw.updates.scene && (!object(raw.updates.scene) || Object.keys(raw.updates.scene).some(k=>!['date',before.version===2?'time':'hour','location','present'].includes(k))))fail('invalid scene update.');
  if (raw.updates.scene) after.scene = {...after.scene,...raw.updates.scene};
  if (Object.hasOwn(raw.updates,'event')) after.event = raw.updates.event;
  for (const group of groups) {
    let ops = raw.updates[group];
    if (ops===undefined) continue;
    if (!object(ops)) fail('invalid '+group+' operations.');
    ops=raw.updates[group]={...ops,upsert:ops.upsert===undefined?[]:ops.upsert,close:ops.close===undefined?[]:ops.close};
    if (!Array.isArray(ops.upsert) || !Array.isArray(ops.close) || ops.upsert.some(i=>!object(i)) || ops.close.some(id=>typeof id!=='string') || new Set(ops.upsert.map(i=>i.id)).size!==ops.upsert.length) fail('invalid '+group+' operations.');
    const items = new Map(after[group].map(i=>[i.id,i]));
    for (const proposed of ops.upsert) {
      let item={...proposed};
      if(group!=='decisions' && !items.has(item.id) && item.threadMeta) {
        const identity=threadIdentity(item.threadMeta),matches=identity?[...items.values()].filter(old=>threadIdentity(old.threadMeta)===identity):[];
        if(matches.length===1)item.id=matches[0].id;
      }
      if(item.threadMeta?.outcome==='expired-unresolved') {
        const candidate=threadLifecycle({...item,status:'open',threadMeta:{...item.threadMeta,outcome:null}},after.scene);
        if(!candidate.threadExpired)fail('thread expiry is not supported by canonical story time.');
      }
      items.set(item.id,{...items.get(item.id),...item});
    }
    for (const id of ops.close) {if(!items.has(id))fail('cannot close an unknown '+group+' item.');items.set(id,{...items.get(id),status:'closed',...(group!=='decisions'?{threadMeta:normalizeThreadMeta({...items.get(id).threadMeta,outcome:'resolved'})}:{})});}
    after[group]=[...items.values()];
  }
  if(raw.action==='narrate')after=settleDirectorState(after);
  after = validateDirectorState(after);
  if(raw.encounterCharacterIds!==undefined) {
    if(!Array.isArray(raw.encounterCharacterIds)||raw.encounterCharacterIds.length>100||new Set(raw.encounterCharacterIds).size!==raw.encounterCharacterIds.length||raw.encounterCharacterIds.some(id=>{
      const e=entries.find(e=>known.has(id)&&e.id===id&&e.book==='characters');
      return !e || [e.name,...(e.aliases ?? [])].some(n=>normalizeName(n)===normalizeName(protagonist));
    }))fail('encounterCharacterIds must contain distinct offered NPC card IDs; seeking someone does not establish presence.');
    raw.memoryIds=[...new Set([...raw.memoryIds,...raw.encounterCharacterIds])];
  }
  if(raw.focusCharacterIds!==undefined) {
    const ids=raw.focusCharacterIds;
    if(!Array.isArray(ids)||ids.length>focusLimit||new Set(ids).size!==ids.length||ids.some(id=>{
      const e=entries.find(e=>known.has(id)&&e.id===id && e.book==='characters');
      return !e || [e.name,...(e.aliases ?? [])].some(n=>normalizeName(n)===normalizeName(protagonist)) || !after.scene.present.some(n=>[e.name,...(e.aliases ?? [])].some(name=>normalizeName(name)===normalizeName(n)));
    }))fail('focusCharacterIds must contain distinct present NPC card IDs within the focus limit. Use encounterCharacterIds for NPCs being sought but not yet present.');
    raw.memoryIds=[...new Set([...raw.memoryIds,...ids])];
    if(raw.memoryIds.length>100)fail('too many selected memory cards.');
  }
  if(raw.memoryIds.length>100)fail('too many selected memory cards.');
  const oldClock=before.version===2?parseClock(before.scene.time):before.scene.hour,newClock=after.version===2?parseClock(after.scene.time):after.scene.hour;
  const oldDate=parseStoryDate(before.scene.date),newDate=parseStoryDate(after.scene.date);
  if(oldDate?.valid && newDate?.valid && (newDate.ordinal<oldDate.ordinal || newDate.ordinal===oldDate.ordinal && oldClock!==null && newClock!==null && newClock<oldClock))fail('clock rollover needs the following date; story time cannot move backwards.');
  if (raw.action !== 'narrate' && JSON.stringify(after)!==JSON.stringify(before)) fail('answer-only and waiting contracts must keep state unchanged.');
  return {contract:raw,before:structuredClone(before),after};
}
export function activeDirectorState(state) {
  const live = structuredClone(state);delete live.archive;
  for (const group of groups) live[group] = (live[group] ?? []).filter(i=>!['closed','cancelled'].includes(i.status));
  return validateDirectorState(live);
}
export function directorSceneWarnings(tag, state) {
  if (!tag) return [];
  const a=parseScene(tag),b=parseScene(directorScene(state));
  return ['when','time','place','present'].some(k=>JSON.stringify(a[k])!==JSON.stringify(b[k])) ? ['Narrator scene tag disagreed with the Director; canonical state was kept.'] : [];
}
