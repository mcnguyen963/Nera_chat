import { directorResponseFormat, isDirectorSchemaEndpoint } from './director-schema.js';
import { attendanceHints } from './director-cast.js';
import { selectScheduledPlan, renderPlanUnit } from './scheduled-plan.js';
import { prompts } from './system-prompts.js';
import { normalizeMemory } from './memory-settings.js';
import { resolveModelProfile } from './model-profiles.js';
import { activeDirectorState, directorScene, playerStopBoundary } from './director-state.js';
import { parseScene, readSceneOutput } from './scene.js';
import { usableLore } from './continuity.js';
import { selectEntries, renderEntry, findMentions } from './lore-select.js';
import { recordUnits } from './lore-record-select.js';
import { capLoreNotes, noteOmissions } from './lore-note-window.js';
import * as tokenizer from './tokenizer.js';
const {countTokens}=tokenizer;
import { requestInputLimit, MESSAGE_FRAME_TOKENS, REQUEST_FRAME_TOKENS } from './request-budget.js';
const tokenCaches=new WeakMap();
function cachedCount(counter) {
  let cache=tokenCaches.get(counter);if(!cache){cache={values:new Map(),size:0};tokenCaches.set(counter,cache);}
  const epoch=tokenizer.tokenizerMode?.();if(cache.epoch!==epoch){cache.values.clear();cache.size=0;cache.epoch=epoch;}
  const ready=()=>counter!==countTokens || !tokenizer.tokenizerStatus || ['ok','estimate'].includes(tokenizer.tokenizerStatus());
  return async text=>{
    if(!ready()){cache.values.clear();cache.size=0;}
    if(cache.values.has(text))return cache.values.get(text);
    const n=await counter(text);
    if(cache.values.size>=128 || cache.size+text.length>2000000){cache.values.clear();cache.size=0;}
    if(ready() && text.length<=200000){cache.values.set(text,n);cache.size+=text.length;}
    return n;
  };
}
const indexCache=new Map();
function entityIndex(entries) {
  const rows=entries.filter(e=>['characters','locations'].includes(e.book)).map(e=>({id:e.id,book:e.book,name:e.name,aliases:e.aliases ?? [],brief:brief(e)}));
  const key=JSON.stringify(rows);if(indexCache.has(key))return indexCache.get(key);
  if(indexCache.size>=4)indexCache.clear();indexCache.set(key,rows);return rows;
}
export const DIRECTOR_RESPONSE_FORMAT=Object.freeze({type:'json_object'});
export function directorOutputOptions(settings,context) {
  return {responseFormat:context?.responseFormat ?? DIRECTOR_RESPONSE_FORMAT,
    ...(/^https:\/\/openrouter\.ai\//i.test(settings.endpoint) ? {provider:{require_parameters:true}} : {})};
}
export function directorTaskSettings(settings) {
  if (!settings.directorProfileId) throw new Error('Choose a Director connection profile in story settings.');
  const task=resolveModelProfile(settings,settings.directorProfileId,{role:'Director'});
  if(!task.apiKey || !task.modelId)throw new Error('The Director profile needs an API key and Model ID.');
  // A different connection must not inherit the narrator model's window size.
  return {...task,streaming:false,maxResponseTokens:settings.directorMaxOutputTokens,maxContextTokens:settings.directorMaxInputTokens,modelContextTokens:null};
}
export async function buildDirectorContext(session, settings, messages, entries, before, {continuation=false,count=countTokens}={}) {
  count=cachedCount(count);
  const mem=normalizeMemory(session.memory),available=usableLore(entries,messages,session,Infinity,before.scene).entries;
  const capCompanions=[];
  const capped=available.map(entry=>{
    if(entry.schemaVersion!==3)return capLoreNotes(entry,mem.loreNotesPerSection);
    const selected=recordUnits(entry,{loreNotesPerSection:mem.loreNotesPerSection});
    capCompanions.push(...selected.capCompanions);
    const ids=new Set(selected.units.filter(u=>!u.blocked).flatMap(u=>u.resolved.sources.map(s=>s.lineId)));
    return {...selected.entry,sections:Object.fromEntries(Object.entries(selected.entry.sections).map(([key,s])=>[key,{...s,lines:s.lines.filter(l=>ids.has(l.id))}]))};
  });
  const cappedById=new Map(capped.map(entry=>[entry.id,entry]));
  const raw=messages.filter(m=>['user','assistant'].includes(m.role) && !(session.directorAbandonedTurnIds ?? []).includes(m.directorTurnId)).sort((a,b)=>a.order-b.order);
  const latest=continuation ? {role:'user',content:'Continue the latest completed narration within player-agency boundaries.'} : raw.findLast(m=>m.role==='user');
  if(!latest)throw new Error('Director needs a user action.');
  const recent=raw.filter(m=>m!==latest),pairs=[];let pair=[];
  for(const m of recent){if(m.role==='user' && pair.length){if(pair.some(x=>x.role==='assistant'))pairs.push(pair);pair=[];}pair.push(m);}
  if(pair.some(x=>x.role==='assistant'))pairs.push(pair);
  let window=pairs.slice(-settings.directorRecentTurns).flat();
  const index=entityIndex(capped);
  const controlMem={...mem,scene:true,lorebooks:true};
  const text=latest.content,recentText=window.map(m=>m.content).join('\n');
  const selection=selectEntries(available,controlMem,text,parseScene(directorScene(before)),recentText,{records:session.loreSchemaVersion===3});
  const anchors=new Set([...selection.selected.characters,...selection.selected.locations].map(i=>i.entry.id));
  const directIds=new Set([...findMentions(text,selection.index,'characters'),...findMentions(text,selection.index,'locations')]);
  const requested=available.filter(e=>directIds.has(e.id)).map(entry=>({entry}));
  const candidates=[...new Map([...requested,...selection.selected.characters,...selection.selected.locations,...selection.selected.facts,...selection.selected.events].map(item=>[item.entry.id,item])).values()];
  const protagonist=available.find(e=>e.book==='characters' && e.name===mem.protagonist);
  if(protagonist){const i=candidates.findIndex(item=>item.entry.id===protagonist.id);if(i>=0)candidates.splice(i,1);candidates.unshift({entry:protagonist});}
  const roster=attendanceHints(capped,text,before.scene);
  const control=[...selectScheduledPlan(available,before.scene.date,latest.planJump ?? null).selected.map(item=>({id:item.entry.id,name:item.entry.name,text:renderPlanUnit(item).slice(0,6000)})),...roster];let controlTokens=0;
  while(control.length && await count(JSON.stringify(control))>4500)control.pop();
  controlTokens=await count(JSON.stringify(control));
  for(const {entry} of candidates){
    const constraints=entry.schemaVersion===3 ? recordUnits(entry,{loreNotesPerSection:mem.loreNotesPerSection,anchors,currentText:text,recentText,index:selection.index}).units.filter(u=>!u.blocked && (u.core || u.pinned || ['constraint','state'].includes(u.category))).map(u=>u.resolved.text).join('\n') : renderEntry(cappedById.get(entry.id),null,mem.protagonist);
    const excerpt=constraints.slice(0,6000),tokens=await count(excerpt);
    if(excerpt && controlTokens+tokens<=4500){control.push({id:entry.id,name:entry.name,text:excerpt});controlTokens+=tokens;}
  }
  const live=activeDirectorState(before);
  const authorPlan=session.longTermPlan ?? '',authorPlanTokens=await count(authorPlan);
  const authorPlanLimit=Math.min(2000,Math.floor(requestInputLimit(directorTaskSettings(settings))/5));
  // Keep a short plan whole. Long plans stay with the Narrator instead of
  // displacing the Director's live ledger, index and recent conversation.
  // Never truncate a passage and silently drop a qualifying constraint.
  const planOmitted=authorPlanTokens>authorPlanLimit;
  const base={state:live,focusLimit:settings.directorFocusLimit ?? 5,player:mem.protagonist || null,playerBoundary:continuation?null:playerStopBoundary(latest.content),entityIndex:index,controlLore:control,fixedAuthorPlan:planOmitted ? '' : authorPlan,fixedAuthorPlanStatus:planOmitted ? 'omitted; full plan remains in Narrator context' : 'complete',scheduledPlans:available.filter(e=>e.book==='plan').map(e=>({id:e.id,name:e.name,brief:brief(e),schedule:e.schedule ? {start:e.schedule.start,end:e.schedule.end,status:e.schedule.status,phases:e.schedule.phases.map(p=>({id:p.id,title:p.title,start:p.start,end:p.end,status:p.status}))} : null})),authorTimeSkip:latest.planJump ?? null,intent:continuation?'continue':'user-action'};
  const planGuard=planOmitted ? '\nThe full fixed author plan is omitted from this small context and remains with the Narrator. Omission does not remove its constraints or authorize planned future events. Use the live ledger, selected control lore and explicit player action. When a transition depends on unavailable plan details, keep it unresolved and stop before that transition; do not guess. The author can place essential current constraints in the live ledger or control lore.' : '';
  const responseFormat=()=>directorResponseFormat(directorTaskSettings(settings),{entries:available,before:live,offeredIds:[...index.map(e=>e.id),...control.map(e=>e.id),...base.scheduledPlans.map(e=>e.id)],protagonist:mem.protagonist,focusLimit:settings.directorFocusLimit ?? 5});
  const schemaCost=async()=>isDirectorSchemaEndpoint(directorTaskSettings(settings)) ? await count(JSON.stringify(responseFormat())) : 0;
  const render=()=>[{role:'system',content:(settings.directorSystemPrompt || prompts.director)+'\n\n'+prompts.threadPolicy+planGuard+'\n\n'+JSON.stringify(base)},...window.map(m=>({role:m.role,content:m.role==='assistant'?readSceneOutput(m.content).clean:m.content})),{role:'system',content:prompts.directorOutput},{role:'user',content:latest.content}];
  const total=async()=>await schemaCost()+REQUEST_FRAME_TOKENS+(await Promise.all(render().map(async m=>MESSAGE_FRAME_TOKENS+await count(m.content)))).reduce((a,b)=>a+b,0);
  const limit=requestInputLimit(directorTaskSettings(settings));
  // Retain direct-action control lore ahead of older conversation when the
  // response schema consumes space. Never trim the current action/state/index.
  while(await total()>limit) {
    const optional=control.findLastIndex(e=>!directIds.has(e.id));
    if(optional>=0){control.splice(optional,1);continue;}
    if(window.length){let n=1;while(n<window.length && window[n].role!=='user')n++;window=window.slice(n);continue;}
    if(control.length){control.pop();continue;}
    break;
  }
  const usedTokens=await total();
  if(usedTokens>limit)throw new Error('Director state, entity index and latest input exceed its input budget. Increase the Director limit or shorten the live ledger.');
  return {apiMessages:render(),responseFormat:responseFormat(),entries:available,report:{noteLimits:{limit:mem.loreNotesPerSection,omitted:[...capped.flatMap(noteOmissions),...capCompanions]},mode:'director',responseFormat:responseFormat().type,responseSchemaTokens:await schemaCost(),offeredMemoryIds:[...index.map(e=>e.id),...control.map(e=>e.id),...base.scheduledPlans.map(e=>e.id)],totals:{input:usedTokens,max:limit},recentMessages:window.map(m=>m.id),controlMemoryIds:control.map(e=>e.id),rosterHints:control.filter(e=>e.kind).map(e=>({group:e.group,memberIds:e.memberIds,source:e.source})),focusLimit:settings.directorFocusLimit ?? 5,fixedAuthorPlan:{tokens:authorPlanTokens,limit:authorPlanLimit,included:!planOmitted},warnings:[...(control.length<candidates.length?['Some control lore was omitted; unknown transitions must remain unresolved.']:[]),...(planOmitted?['The fixed author plan exceeds the Director plan budget and stays in Narrator context. Put essential current constraints in the live ledger or control lore.']:[])]},usedTokens};
}
function brief(entry) {
  const section=[entry.sections?.description,entry.sections?.state,entry.sections?.status,...Object.values(entry.sections ?? {})].find(s=>s && [s.text,...(s.lines ?? []).map(l=>l.text)].some(t=>t?.trim()));
  // This is a discovery hint, not a full card or an authoritative constraint.
  // Keep large casts from crowding current control lore out of the small call.
  return [section?.text,...(section?.lines ?? []).map(l=>l.text)].filter(Boolean).join(' ').slice(0,160);
}
export function narratorDirectorContract(turn,{includeRules=true}={}) {
  return (includeRules ? prompts.directorNarrator+'\n\n' : '')+'Director contract:\n'+JSON.stringify({startingState:{scene:turn.before.scene,event:turn.before.event},targetState:{scene:turn.after.scene,event:turn.after.event},playerBoundary:turn.playerBoundary ?? null,pendingDecisions:turn.after.decisions.filter(i=>!['closed','cancelled'].includes(i.status)),readyCommitments:turn.after.commitments.filter(i=>i.status==='ready'),...(turn.cast?.backgroundNames.length ? {cast:{focusedNames:turn.cast.focusedNames,backgroundNames:turn.cast.backgroundNames}} : {}),contract:turn.contract});
}
