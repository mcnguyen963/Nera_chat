import { buildLoreIndex, findMentions } from './lore-select.js';
import { normalizeName } from './lore-lines.js';

const matches=(entry,name)=>[entry.name,...(entry.aliases ?? [])].some(n=>normalizeName(n)===normalizeName(name));
export function directorCast(turn,entries,{protagonist='',limit=5,currentText='',recentText=''}={}) {
  const people=entries.filter(e=>e.book==='characters'),present=turn.after.scene.present;
  const attendees=people.filter(e=>present.some(n=>matches(e,n))),index=buildLoreIndex(people);
  const current=new Set(findMentions(currentText,index,'characters')),recent=findMentions(recentText,index,'characters');
  const player=people.find(e=>matches(e,protagonist)),required=new Set(turn.contract.requiredMemoryIds);
  const active=new Set(findMentions([turn.after.event?.name,turn.after.event?.phase,...(turn.after.threads ?? []).filter(t=>!['closed','cancelled'].includes(t.status)).map(t=>t.text)].filter(Boolean).join(' '),index,'characters'));
  const explicit=turn.contract.focusCharacterIds;
  const ranked=attendees.filter(e=>e.id!==player?.id).sort((a,b)=>Number(current.has(b.id))-Number(current.has(a.id))||Number(required.has(b.id))-Number(required.has(a.id))||Number(active.has(b.id))-Number(active.has(a.id))||Number(recent.includes(b.id))-Number(recent.includes(a.id))||recent.lastIndexOf(b.id)-recent.lastIndexOf(a.id)||a.id.localeCompare(b.id));
  const focused=explicit===undefined ? ranked.slice(0,limit).map(e=>e.id) : explicit;
  const focus=new Set([...focused,...(player ? [player.id] : [])]);
  return {focusCharacterIds:focused,playerCharacterId:player?.id ?? null,focusedNames:attendees.filter(e=>focus.has(e.id)).map(e=>e.name),backgroundNames:present.filter(name=>!attendees.some(e=>focus.has(e.id)&&matches(e,name))),backgroundCharacterIds:attendees.filter(e=>!focus.has(e.id)).map(e=>e.id)};
}

// These are source-linked membership candidates, never declarations of attendance.
// Keep whole passages, including exceptions/absences; the Director evaluates them.
export function attendanceHints(entries,currentText,scene) {
  const groups=[...new Set([...String(currentText+' '+(scene?.location ?? '')).matchAll(/\bclass\s+([a-z])\b/gi)].map(m=>'Class '+m[1].toUpperCase()))];
  if(!groups.length)return [];
  const index=buildLoreIndex(entries),result=[];
  for(const entry of entries)for(const [section,value] of Object.entries(entry.sections ?? {}))for(const source of [{text:value.text,lineId:null},...(value.lines ?? []).map(l=>({text:l.text,lineId:l.id}))]) {
    const text=source.text ?? '',labels=[...new Set([...text.matchAll(/\bclass\s+([a-z])\b/gi)].map(m=>'Class '+m[1].toUpperCase()))];
    if(text.length>1600 || labels.length!==1 || !groups.includes(labels[0]))continue;
    const ids=findMentions(text,index,'characters');if(entry.book==='characters')ids.unshift(entry.id);
    if(!ids.length)continue;
    result.push({id:entry.id,name:entry.name,kind:'roster evidence; evaluate attendance and exceptions',group:labels[0],memberIds:[...new Set(ids)],source:{section,lineId:source.lineId},text});
  }
  return result.sort((a,b)=>a.id.localeCompare(b.id)||a.source.section.localeCompare(b.source.section)||(a.source.lineId ?? '').localeCompare(b.source.lineId ?? ''));
}
