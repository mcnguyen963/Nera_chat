import { characterImportance } from './character-importance.js';
import { normalizeName } from './lore-lines.js';

function protagonistCharacter(item,protagonist) {
  return item.reason==='protagonist' || !!protagonist && [item.entry.name,...(item.entry.aliases ?? [])].some(name=>normalizeName(name)===normalizeName(protagonist));
}
export function priorityCharacter(item,protagonist='') {
  return characterImportance(item.entry)<=2 || protagonistCharacter(item,protagonist);
}
export function characterCardSlots(candidates,limit,{protagonist='',requiredIds=[]}={}) {
  const cap=Math.max(0,Math.floor(limit)),required=new Set(requiredIds);
  if(candidates.length<=cap)return new Set(candidates);
  if(cap<2)return new Set(candidates.slice(0,cap));
  const priority=candidates.filter(item=>priorityCharacter(item,protagonist)),supporting=candidates.filter(item=>!priorityCharacter(item,protagonist));
  if(!priority.length || !supporting.length)return new Set(candidates.slice(0,cap));
  const chosen=new Set(candidates.filter(item=>required.has(item.entry.id)).slice(0,cap));
  const available=cap-chosen.size,supportingSlots=Math.min(available,Math.max(0,Math.ceil(cap*.2)-supporting.filter(item=>chosen.has(item)).length));
  for(const item of priority.filter(item=>!chosen.has(item)).slice(0,available-supportingSlots))chosen.add(item);
  for(const item of supporting.filter(item=>!chosen.has(item)).slice(0,supportingSlots))chosen.add(item);
  for(const item of [...priority,...supporting]){if(chosen.size>=cap)break;chosen.add(item);}
  return chosen;
}

// Fitters keep ownership of indivisible source units and exact rendering. This
// scheduler only controls admission: initial 80/20 shares, then shared leftovers.
export async function allocateCharacterPools(records,budget,count,render,fill,{protagonist='',requiredIds=[]}={}) {
  const cap=Math.max(0,budget),required=new Set(requiredIds),priority=records.filter(r=>priorityCharacter(r,protagonist)),supporting=records.filter(r=>!priorityCharacter(r,protagonist));
  const mixed=priority.length>0 && supporting.length>0;
  const allText=()=>records.map(render).filter(Boolean).join('\n\n');
  const protectedRecords=records.filter(r=>protagonistCharacter(r,protagonist) || required.has(r.entry.id) || r.entry.alwaysLoad || r.reason==='pinned record');
  const phases=mixed ? [
    {records:protectedRecords,protectedOnly:true},
    {records:priority,limit:Math.floor(cap*.8)},
    {records:supporting,limit:cap-Math.floor(cap*.8)},
    {records:priority},
    {records:supporting}
  ] : [{records}];
  for(const phase of phases) {
    const fits=async()=>await count(allText())<=cap && (phase.limit===undefined || await count(phase.records.map(render).filter(Boolean).join('\n\n'))<=phase.limit);
    await fill(phase.records,fits,!!phase.protectedOnly);
  }
  return characterPoolReport(records,cap,count,render,{protagonist,protectedIds:protectedRecords.map(r=>r.entry.id)});
}
export async function characterPoolReport(records,budget,count,render,{protagonist='',protectedIds=[]}={}) {
  const groups={};
  for(const [key,flag] of [['priority',true],['supporting',false]]) {
    const members=records.filter(r=>priorityCharacter(r,protagonist)===flag),text=members.map(render).filter(Boolean).join('\n\n');
    const allocation=flag ? Math.floor(budget*.8) : budget-Math.floor(budget*.8),used=await count(text);
    groups[key]={allocation,used,borrowed:Math.max(0,used-allocation),eligible:members.length,included:members.filter(r=>!!render(r)).length};
  }
  const tokens=await count(records.map(render).filter(Boolean).join('\n\n'));
  const omitted=records.filter(r=>!render(r)).map(r=>({entryId:r.entry.id,name:r.entry.name,importance:characterImportance(r.entry),group:priorityCharacter(r,protagonist)?'priority':'supporting',reason:'No complete character information fits the available budget.'}));
  return {budget,split:'80/20',...groups,tokens,framing:tokens-groups.priority.used-groups.supporting.used,protectedIds,omitted};
}
