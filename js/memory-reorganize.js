import {requestInputLimit} from './request-budget.js';
import { buildReorganizeMessages } from './memory-prompts.js';
import { parseMemoryLines, applyOps } from './lore-lines.js';
import { countTokens } from './tokenizer.js';
import { chatCompletion } from './llm-client.js';
import { computeTurns } from './turns.js';
import { memoryTaskSettings } from './memory-settings.js';
import { usableLore } from './continuity.js';
import { capLoreNotes, noteOmissions } from './lore-note-window.js';

function prepareNotes(live,entries,sections) {
  const available=usableLore(entries,live.messages,live.session ?? {},Infinity,null,{includeArchived:true});
  const cards=available.entries.map(entry=>capLoreNotes(entry,live.mem.loreNotesPerSection)).map(e=>({...e,sections:Object.fromEntries(Object.entries(e.sections).map(([key,s])=>[key,{
    ...s,userCanon:s.userCanon ?? (s.lines ?? []).filter(l=>l.by==='user'),
    lines:(s.lines ?? []).filter(l=>l.by!=='user' && !l.needsReview && (!sections || sections[e.id]?.includes(key)))
  }]))}));
  return {cards,omitted:[...available.skipped,...cards.flatMap(noteOmissions)]};
}

function omissionWarnings(omitted) {
  const groups=new Map();
  for(const item of omitted){const key=JSON.stringify([item.entryId,item.section,item.reason]);const group=groups.get(key) ?? {item,count:0};group.count++;groups.set(key,group);}
  return [...groups.values()].map(({item,count})=>`${item.name} · ${item.section ?? 'card'}: ${count} note(s) not sent (${item.reason}); saved notes are kept.`);
}
export async function planReorganize(live,entries,sections,instruction = '',count = countTokens) {
  const prepared=prepareNotes(live,entries,sections);
  const mem = live.mem, settings = memoryTaskSettings(live.settings,mem,mem.reorganizeMaxTokens), batches = [], warnings = omissionWarnings(prepared.omitted); let batch = [];
  const cost = async cards => { const messages = buildReorganizeMessages({ settings,mem,entries:cards,sections,instruction }); return 24+(await Promise.all(messages.map(m => count(m.content)))).reduce((a,b) => a+b,0); };
  const cap = requestInputLimit({...settings,maxResponseTokens:mem.reorganizeMaxTokens})-500;
  for (const e of prepared.cards) {
    if(!Object.values(e.sections).some(s=>s.lines.length))continue;
    if (batch.length && await cost([...batch,e]) > cap) { batches.push(batch); batch = []; }
    let removed = 0;
    while (await cost([e]) > cap) {
      const oldest = Object.entries(e.sections).flatMap(([key,s]) => s.lines.map(l => ({ key,l }))).sort((a,b) => (a.l.turn??0)-(b.l.turn??0)||a.l.at-b.l.at)[0];
      if (!oldest) throw new Error(e.name+': Your text is too large for a reorganize request. Raise Max context tokens.');
      e.sections[oldest.key].lines = e.sections[oldest.key].lines.filter(l => l.id !== oldest.l.id); removed++;
    }
    if (removed) warnings.push(`Token budget: only the newest ${Object.values(e.sections).reduce((n,s) => n+s.lines.length,0)} lines of ${e.name} were reorganized`);
    batch.push(e);
  }
  if (batch.length) batches.push(batch);
  return { batches,warnings,noteOmissions:prepared.omitted,inputTokens:(await Promise.all(batches.map(cost))).reduce((a,b) => a+b,0) };
}
export async function runReorganizeBatch(live,entries,sections,instruction,{ signal,onDelta,count = countTokens,complete = chatCompletion } = {}) {
  const originals=entries,prepared=prepareNotes(live,entries,sections);
  entries=prepared.cards.filter(e=>Object.values(e.sections).some(s=>s.lines.length));
  if(!entries.length)throw new Error('No eligible notes to reorganize. Saved notes are unchanged.');
  const settings=memoryTaskSettings(live.settings,live.mem,live.mem.reorganizeMaxTokens);
  const messages = buildReorganizeMessages({ settings,mem:live.mem,entries,sections,instruction });
  if (24+(await Promise.all(messages.map(m => count(m.content)))).reduce((a,b) => a+b,0)>requestInputLimit(settings)) throw new Error('Reorganize input exceeds the context budget.');
  const result = await complete({ settings,messages,signal,onDelta,onReasoning:() => {} });
  const parsed = parseMemoryLines(result.content,{ reorganize:true,allowPersonality:true,entries,messages:live.messages,mem:live.mem });
  if (!parsed.valid) { const error = new Error("Invalid reorganization; nothing was changed."); error.raw = result.content; throw error; }
  const empty = entries.map(e => ({ ...e,sections:Object.fromEntries(Object.entries(e.sections).map(([key,s]) => [key,{ ...s,lines:[] }])) }));
  const changes = applyOps(empty,parsed.ops,{ reorganize:true,allowPersonality:true,allowedIds:entries.map(e => e.id),mem:live.mem });
  const accepted = changes.appends.filter(a => sections[a.entryId]?.includes(a.section));
  if (!accepted.length) { const error = new Error("The model's answer couldn't be read as notes. Nothing was changed."); error.raw = result.content; throw error; }
  const turns = computeTurns(live.messages);
  const previews = entries.map(e => ({ entry:e,include:true,sent:Object.fromEntries(Object.entries(e.sections).map(([key,s])=>[key,s.lines.filter(l=>l.by!=='user').map(l=>({id:l.id,text:l.text}))])),snapshot:Object.fromEntries(Object.entries(e.sections).map(([key,s])=>[key,s.lines.map(l=>l.id)])),sections:Object.fromEntries((sections[e.id] ?? []).map(key => [key,accepted.filter(a => a.entryId === e.id && a.section === key).map(a => {
    const original = [...e.sections[key].lines].filter(l => l.turn === a.line.turn).sort((a,b) => a.at-b.at).at(-1) ?? e.sections[key].lines.at(-1);
    return { ...a.line,when:original?.when ?? a.line.when,src:original?.src ?? turns.assistants.find(t => t.turn === a.line.turn)?.order ?? null,evidence:original?.evidence ?? a.line.evidence ?? [],sourceRevision:original?.sourceRevision ?? a.line.sourceRevision ?? 0 };
  })])) }));
  for(const preview of previews) {
    const original=originals.find(e=>e.id===preview.entry.id);
    for(const key of Object.keys(preview.sections)) {
      const sentIds=new Set(preview.sent[key].map(l=>l.id));
      preview.sections[key]=[...(original.sections[key].lines ?? []).filter(l=>l.by!=='user'&&!sentIds.has(l.id)),...preview.sections[key]];
    }
    preview.entry=original;
    preview.snapshot=Object.fromEntries(Object.entries(original.sections).map(([key,s])=>[key,(s.lines ?? []).map(l=>l.id)]));
  }
  return { previews,skipped:[...parsed.skipped,...changes.skipped],noteOmissions:prepared.omitted,raw:result.content };
}
