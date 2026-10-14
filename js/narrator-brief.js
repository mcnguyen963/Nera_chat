import { prompts, renderPrompt } from './system-prompts.js';
import { narratorDirectorContract } from './director-context.js';
import { directorScene } from './director-state.js';
import { parseScene } from './scene.js';
import { resolveScene, renderEntry } from './lore-select.js';
import { renderCharacterSelection } from './character-select.js';

export const BRIEF_LORE_LIMIT=1500;
export function replySubjects(turn,index) {
  const ids=new Set(turn.contract.memoryIds);
  for(const state of [turn.before,turn.after]){const resolved=resolveScene(parseScene(directorScene(state)),index);for(const id of resolved.characters)ids.add(id);if(resolved.place)ids.add(resolved.place);}
  return ids;
}
export function fittedPassage(item,book,{recordMode=false,characterSelection=false,protagonist=''}={}) {
  return book==='characters' && characterSelection && !recordMode
    ? renderCharacterSelection(item.entry,item.chosen,protagonist)
    : renderEntry(item.entry,item.lineIds,protagonist);
}
export function withoutBriefEntries(fits,ids,options) {
  return Object.fromEntries(Object.entries(fits).map(([book,fit])=>{
    if(book==='plan')return [book,fit];
    const included=fit.included.filter(i=>!ids.has(i.entry.id));
    return [book,{...fit,included,text:included.map(i=>fittedPassage(i,book,options)).join('\n\n')}];
  }));
}
// Relocate whole fitted entries. Each entry contains complete selected records or
// legacy source units; moving the union preserves overlapping/core qualifications.
export async function buildReplyBrief({turn,userSource,fits,options,count,canRelocate}) {
  const passages=[],sources=[],omitted=[],ids=new Set();
  const realization=turn.playerBoundary?.kind==='arrival' && turn.contract.transition==='completed' && turn.before.scene.location!==turn.after.scene.location ? renderPrompt(prompts.narratorArrival,{FROM:turn.before.scene.location,TO:turn.after.scene.location}) : '';
  const render=()=>renderPrompt(prompts.narratorBrief,{USER_SOURCE:userSource ?? 'unknown',CONTRACT:narratorDirectorContract(turn,{includeRules:false}),PASSAGES:passages.join('\n\n'),REALIZATION:realization});
  const priority=item=>item.chosen?.some(u=>u.category) ? Math.min(...item.chosen.map(u=>['constraint','state'].includes(u.category)?0:['characterization','relationship'].includes(u.category)?1:2)) : item.entry.book==='facts' || item.entry.sections.state?.text || item.entry.sections.status?.text ? 0 : item.entry.book==='characters' ? 1 : 2;
  const candidates=Object.entries(fits).filter(([book])=>book!=='plan').flatMap(([book,fit])=>fit.included.map(item=>({book,item}))).sort((a,b)=>priority(a.item)-priority(b.item)||a.item.entry.id.localeCompare(b.item.entry.id));
  let remaining=fits,loreTokens=0;
  for(const {book,item} of candidates) {
    if(options.relevantEntryIds && !options.relevantEntryIds.has(item.entry.id) && item.reason!=='protagonist'){
      omitted.push({entryId:item.entry.id,name:item.entry.name,reason:'not selected for this reply brief; source remains in normal memory'});continue;
    }
    const text=fittedPassage(item,book,options),passage=renderPrompt(prompts.narratorBriefSource,{BOOK:book,NAME:item.entry.name,ENTRY_ID:item.entry.id,TEXT:text});
    const nextLoreTokens=await count([...passages,passage].join('\n\n'));
    if(nextLoreTokens>BRIEF_LORE_LIMIT){omitted.push({entryId:item.entry.id,name:item.entry.name,reason:'brief limit; source remains in normal memory'});continue;}
    ids.add(item.entry.id);passages.push(passage);
    const trial=withoutBriefEntries(fits,ids,options),trialText=render();
    const movedByBook=Object.fromEntries(Object.keys(fits).map(b=>[b,passages.filter((_,i)=>[...sources,{book}][i].book===b).join('\n\n')]));
    if(!await canRelocate(trial,trialText,movedByBook)) {
      ids.delete(item.entry.id);passages.pop();omitted.push({entryId:item.entry.id,name:item.entry.name,reason:'request or book budget; source remains in normal memory'});continue;
    }
    const refs=(item.chosen ?? []).flatMap(u=>u.resolved?.sources ?? u.sources ?? []).map(s=>({section:s.section,lineId:s.lineId ?? null,start:s.start,end:s.end}));
    sources.push({entryId:item.entry.id,name:item.entry.name,book,recordIds:(item.chosen ?? []).map(u=>u.id),sourceRefs:refs,lineIds:[...item.lineIds],text});
    remaining=trial;loreTokens=nextLoreTokens;
  }
  return {text:render(),fits:remaining,report:{text:render(),loreTokens,limit:BRIEF_LORE_LIMIT,sources,omitted,userSource}};
}
