import { renderEntry, sortLines } from './lore-select.js';
import { SECTION_KEYS, normalizeName } from './lore-lines.js';
import { resolveCore } from './character-core.js';
const GENERIC = new Set(('a an the and or but if when then of to in on for with from by as at is are was were be been being has have had do does did not no can could will would may might must shall should his her their its he she they it you your we our i me my this that these those who what how where now only also very more most some all any each own said says character person people story scene turn personality appearance status notes bond relations').split(' '));
const words = text => new Set((normalizeName(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2 && !GENERIC.has(w)));
export function detailMatches(text, currentText, recentText, entry) {
  const ignored = words([entry.name,...(entry.aliases ?? [])].join(' '));
  const source = words(text), current = words(currentText), recent = words(recentText);
  return {current:[...source].filter(w => !ignored.has(w) && current.has(w)).sort(),recent:[...source].filter(w => !ignored.has(w) && recent.has(w)).sort()};
}
export function resolveCharacterUnits(entry, currentText = '', recentText = '') {
  const units = [], invalid = [];
  for (const b of entry.coreReferences ?? []) {
    const core = resolveCore(entry,b);
    if (!core.valid) {invalid.push({id:b.id,reason:core.reason});continue;}
    units.push({id:'core:'+b.id,round:1,reason:'user-reviewed core bundle',sources:core.sources,coverage:core.coverage,current:[],recent:[],author:1,recency:0});
  }
  const cores = [...units], hasCore = cores.length > 0;
  for (const key of SECTION_KEYS.characters) {
    const s = entry.sections[key]; if (!s) continue;
    const candidates = [s.text ? {id:'text:'+key,text:s.text,lineId:null,start:0,end:s.text.length,by:s.origin,at:s.cutoff?.order ?? 0} : null,...sortLines(s.lines ?? []).map(l => ({...l,lineId:l.id,start:0,end:l.text.length}))].filter(Boolean);
    if (!hasCore && ['personality','appearance'].includes(key) && candidates.length) {
      units.push({id:'fallback:'+key,round:1,reason:'complete unreviewed '+key+' section',sources:candidates.map(c=>({section:key,lineId:c.lineId,start:c.start,end:c.end,text:c.text})),coverage:[key],current:[],recent:[],author:1,recency:0});
      continue;
    }
    for (const c of candidates) {
      // A whole section can extend a selected core excerpt; exact rendering
      // merges overlapping ranges without repeating the excerpt.
      const matches = detailMatches(c.text,currentText,recentText,entry);
      const round = key === 'status' ? 2 : matches.current.length || matches.recent.length ? 3 : ['bond','relations','personality','appearance'].includes(key) ? 4 : 5;
      units.push({id:c.lineId == null ? c.id : 'note:'+key+':'+c.id,round,reason:round===2 ? 'valid state' : round===3 ? 'literal input/context matches' : round===4 ? 'relationships or additional characterization' : 'remaining background',sources:[{section:key,lineId:c.lineId,start:c.start,end:c.end,text:c.text}],coverage:[],...matches,author:Number(c.by==='user'),recency:c.turn ?? c.at ?? 0});
    }
  }
  // Any unit touching a reviewed bundle must carry the whole bundle, even
  // when the bundle failed to fit in the core round. Close overlaps transitively.
  const overlaps=(a,b)=>a.section===b.section && a.lineId===b.lineId && a.start<b.end && b.start<a.end;
  for (const u of units) {
    const linked=new Set();let changed=true;
    while(changed) {changed=false;for(const core of cores) {
      if(linked.has(core.id) || !u.sources.some(a=>core.sources.some(b=>overlaps(a,b))))continue;
      linked.add(core.id);u.sources=[...u.sources,...core.sources.filter(s=>!u.sources.some(r=>r.section===s.section && r.lineId===s.lineId && r.start===s.start && r.end===s.end))];u.coverage=[...new Set([...u.coverage,...core.coverage])];changed=true;
    }}
  }
  const cmp = (a,b) => b.current.length-a.current.length || b.recent.length-a.recent.length || b.author-a.author || b.recency-a.recency || (a.id<b.id ? -1 : a.id>b.id ? 1 : 0);
  return {units:units.sort((a,b) => a.round-b.round || cmp(a,b)),invalid};
}
const sourceKey=(section,lineId)=>JSON.stringify([section,lineId]);
export function renderCharacterSelection(entry, units, protagonist = '') {
  const ranges = new Map();
  for (const u of units) for (const s of u.sources) {
    const key = sourceKey(s.section,s.lineId);
    if (!ranges.has(key)) ranges.set(key,[]);
    ranges.get(key).push([s.start,s.end]);
  }
  const sections = Object.fromEntries(SECTION_KEYS.characters.map(key => {
    const s=entry.sections[key] ?? {text:'',lines:[]}, spans=ranges.get(sourceKey(key,null)) ?? [];
    const merged=[];
    for(const [start,end] of spans.sort((a,b)=>a[0]-b[0])) {const last=merged.at(-1);if(last && start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);}
    return [key,{...s,text:merged.map(([a,b])=>s.text.slice(a,b)).join('\n'),lines:(s.lines ?? []).filter(l=>ranges.has(sourceKey(key,l.id)))}];
  }));
  return renderEntry({...entry,sections},null,protagonist);
}
function sourceCoverage(source, chosen) {
  const ranges=chosen.flatMap(u=>u.sources).filter(s=>s.section===source.section && s.lineId===source.lineId).map(s=>[Math.max(s.start,source.start),Math.min(s.end,source.end)]).filter(([a,b])=>a<b).sort((a,b)=>a[0]-b[0]);
  const merged=[];for(const [a,b] of ranges){const last=merged.at(-1);if(last && a<=last[1])last[1]=Math.max(last[1],b);else merged.push([a,b]);}
  const included=[],omitted=[];let cursor=source.start;
  const part=(a,b)=>({start:a,end:b,text:source.text.slice(a-source.start,b-source.start)});
  for(const [a,b] of merged){if(a>cursor)omitted.push(part(cursor,a));included.push(part(a,b));cursor=b;}
  if(cursor<source.end)omitted.push(part(cursor,source.end));
  return {...source,included,omitted};
}
export async function fitCharacters(selected, budget, count, {protagonist='',currentText='',recentText=''} = {}) {
  const cap=Math.max(0,budget), records=selected.map(item=>({...item,...resolveCharacterUnits(item.entry,currentText,recentText),chosen:[],identity:false}));
  const render=()=>records.filter(r=>r.identity).map(r=>renderCharacterSelection(r.entry,r.chosen,protagonist)).join('\n\n');
  const full=selected.map(i=>renderEntry(i.entry,null,protagonist)).join('\n\n'), fullFit=await count(full)<=cap;
  // Test the complete rendering on every proposal. Labels, dates, joins and
  // tokenizer boundaries all belong to the ceiling, even for tiny budgets.
  for (const r of records) {r.identity=true;if(await count(render())>cap)r.identity=false;}
  if (fullFit) for(const r of records) {r.identity=true;r.chosen=[...r.units];}
  else for(let round=1;round<=5;round++) {
    const queues=new Map(records.map(r=>[r,r.units.filter(u=>u.round===round)]));
    let pending=true;
    while(pending) {
      pending=false;
      for(const r of records) {
        if(!r.identity)continue;
        const q=queues.get(r);
        while(q.length) {
          pending=true;const unit=q.shift();r.chosen.push(unit);
          if(await count(render())<=cap)break;
          r.chosen.pop(); // An oversized unit does not block smaller units.
        }
      }
    }
  }
  const text=fullFit ? full : render(), included=[],skipped=[],report=[];
  for(const r of records) {
    const chosen=new Set(r.chosen.map(u=>u.id)),lineIds=new Set(r.chosen.flatMap(u=>u.sources.filter(s=>s.lineId!=null).map(s=>s.lineId)));
    const total=Object.values(r.entry.sections).reduce((n,s)=>n+(s.lines?.length ?? 0),0);
    const coverage=new Set(r.chosen.flatMap(u=>u.coverage));
    const rendered=r.identity ? renderCharacterSelection(r.entry,r.chosen,protagonist) : '';
    if(r.identity)included.push({...r,lineIds,linesSent:lineIds.size,linesCut:total-lineIds.size,tokens:await count(rendered)});
    else skipped.push({entryId:r.entry.id,book:'characters',name:r.entry.name,ranking:r.ranking,reason:'identity over budget'});
    report.push({entryId:r.entry.id,name:r.entry.name,identity:r.identity,full:fullFit,coreCoverage:{personality:coverage.has('personality'),constraints:coverage.has('constraints'),appearance:coverage.has('appearance')},missingCoverage:['personality','constraints','appearance'].filter(k=>!coverage.has(k)),invalidCores:r.invalid,text:rendered,units:r.units.map(u=>({id:u.id,round:u.round,selected:chosen.has(u.id),reason:chosen.has(u.id) ? u.reason : r.identity ? 'unit over budget' : 'identity over budget',currentMatches:u.current,recentMatches:u.recent,authorPreference:u.author,recency:u.recency,sources:u.sources.map(s=>({section:s.section,lineId:s.lineId,start:s.start,end:s.end,text:s.text,...sourceCoverage(s,r.chosen)}))}))});
  }
  const userLinesCut=records.reduce((n,r)=>n+Object.values(r.entry.sections).flatMap(s=>s.lines ?? []).filter(l=>l.by==='user' && !included.find(i=>i.entry.id===r.entry.id)?.lineIds.has(l.id)).length,0);
  return {text,included,skipped,tokens:await count(text),cut:included.reduce((n,r)=>n+r.linesCut,0),userLinesCut,selectionReport:{budget:cap,fullFit,characters:report}};
}
