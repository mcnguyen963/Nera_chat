import {requestInputLimit} from './request-budget.js';
import { buildReorganizeMessages } from './memory-prompts.js';
import { parseMemoryLines, applyOps } from './lore-lines.js';
import { countTokens } from './tokenizer.js';
import { chatCompletion } from './llm-client.js';
import { computeTurns } from './turns.js';
import { memoryTaskSettings } from './memory-settings.js';
export async function planReorganize(live,entries,sections,instruction = '',count = countTokens) {
  const mem = live.mem, settings = memoryTaskSettings(live.settings,mem,mem.reorganizeMaxTokens), batches = [], warnings = []; let batch = [];
  const cost = async cards => { const messages = buildReorganizeMessages({ settings,mem,entries:cards,sections,instruction }); return 24+(await Promise.all(messages.map(m => count(m.content)))).reduce((a,b) => a+b,0); };
  const cap = requestInputLimit({...settings,maxResponseTokens:mem.reorganizeMaxTokens})-500;
  for (const original of entries) {
    const e = structuredClone(original);
    for (const s of Object.values(e.sections)) { s.userCanon = s.lines.filter(l => l.by === 'user'); s.lines = s.lines.filter(l => l.by !== 'user' && !l.needsReview); }
    if (batch.length && await cost([...batch,e]) > cap) { batches.push(batch); batch = []; }
    let removed = 0;
    while (await cost([e]) > cap) {
      const oldest = Object.entries(e.sections).flatMap(([key,s]) => s.lines.map(l => ({ key,l }))).sort((a,b) => (a.l.turn??0)-(b.l.turn??0)||a.l.at-b.l.at)[0];
      if (!oldest) throw new Error(e.name+': Your text is too large for a reorganize request. Raise Max context tokens.');
      e.sections[oldest.key].lines = e.sections[oldest.key].lines.filter(l => l.id !== oldest.l.id); removed++;
    }
    if (removed) warnings.push(`Only the newest ${Object.values(e.sections).reduce((n,s) => n+s.lines.length,0)} lines of ${e.name} were reorganized`);
    batch.push(e);
  }
  if (batch.length) batches.push(batch);
  return { batches,warnings,inputTokens:(await Promise.all(batches.map(cost))).reduce((a,b) => a+b,0) };
}
export async function runReorganizeBatch(live,entries,sections,instruction,{ signal,onDelta,count = countTokens,complete = chatCompletion } = {}) {
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
  return { previews,skipped:[...parsed.skipped,...changes.skipped],raw:result.content };
}
