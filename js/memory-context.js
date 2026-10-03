import { prompts, renderPrompt } from './system-prompts.js';
import { normalizeMemory, memoryActive } from './memory-settings.js';
import { SCENE_RULE, latestScene } from './scene.js';
import { computeTurns } from './turns.js';
import { selectEntries, fitBook, renderFactsBlock, renderEventsBlock, renderMemoryBlock } from './lore-select.js';
import { planInjectionBlock } from './plan-parser.js';
import { CONTINUITY_RULE, usableLore, cutoffLabel, revisionOf } from './continuity.js';
const FRAME = 8;
function stripOcc(content) {
  return content.replace(/<OCC\b[^>]*>[\s\S]*?(?:<\/OCC\s*>|$)|<\/OCC\s*>/gi, '');
}
// Both modes use this renderer and count the entire rendered request on every fit.
export async function buildMemoryContext(session, settings, opts, { count, adRule, normalizeAd }) {
  const mem = normalizeMemory(session.memory), limit = Number(settings.maxContextTokens)-Number(settings.maxResponseTokens);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Context limit must leave space for the request after reserving the reply.');
  const all = opts.messages, upTo = opts.upToOrder ?? Infinity;
  const raw = [...new Map(all.filter(m => ['user','assistant'].includes(m.role) && m.order < upTo).map(m => [m.id,m])).values()].sort((a,b) => a.order-b.order);
  if (opts.draftText?.trim()) raw.push({ id:'__memory_draft',order:(raw.at(-1)?.order ?? 0)+1,role:'user',content:opts.draftText });
  const turns = computeTurns(raw), current = latestScene(raw);
  const firstUser = raw.find(m => m.role === 'user'), firstAssistant = firstUser && raw.find(m => m.role === 'assistant' && m.order > firstUser.order), latest = raw.findLast(m => m.role === 'user');
  const anchors = [firstUser,firstAssistant].filter(Boolean), anchorIds = new Set(anchors.map(m => m.id));
  const required = new Set(anchorIds);
  if (latest) required.add(latest.id);
  if (opts.requireLatestUser && !latest) throw new Error('No user message is available for this request.');
  const system = (settings.narratorSystemPrompt || '')+'\n\n'+adRule+'\n\n'+CONTINUITY_RULE+'\n\n'+planInjectionBlock(session.longTermPlan)+(mem.scene ? '\n\n'+SCENE_RULE(mem.protagonist) : '');
  const head = [{ role:'system',content:system }], blocks = [{ key:'system',label:'Instructions and fixed author plan',tokens:await count(system)+FRAME }];
  let summary = session.activeSummaryMessageId && (session.breakpointOrder ?? 0) < upTo ? all.find(m => m.id === session.activeSummaryMessageId && !m.needsReview) : null;
  if (summary && ((summary.evidence ?? []).some(e => !all.some(m => m.id === e.id && revisionOf(m) === e.revision)) || (session.memoryInvalidations ?? []).some(i => (summary.sourceRevision ?? 0) < i.revision && i.fromOrder <= (summary.coveredRange?.toOrder ?? session.breakpointOrder ?? 0)))) summary = null;
  const checkpoint = summary ? (summary.coveredRange?.toOrder ?? session.breakpointOrder ?? 0) : 0;
  if (summary) {
    const content = renderPrompt(prompts.historicalSummary, { CUTOFF: cutoffLabel({ order:checkpoint,turn:summary.cutoffTurn }), SUMMARY: summary.content });
    head.push({ role:'system',content }); blocks.push({ key:'summary',label:'Summary through message '+checkpoint,tokens:await count(content)+FRAME });
  }
  const contentFor = m => {
    let text = m.role === 'user' ? normalizeAd(m.content) : m.content;
    if (m.role === 'assistant') text += (m.planThread ? '\n<plan_thread>'+m.planThread+'</plan_thread>' : '')+(mem.scene && m.scene ? '\n<scene>'+m.scene+'</scene>' : '');
    if (m.id !== latest?.id) text = stripOcc(text);
    // An opening message that is also the active latest user keeps its current role.
    if (anchorIds.has(m.id) && m.id !== latest?.id) text = renderPrompt(prompts.openingExchange, { TURN: turns.turnById.get(m.id), CONTENT: text });
    return text;
  };
  const selected = new Set(required), books = [], loaded = [], warnings = [];
  if (mem.scene && current.missingStreak > 0) warnings.push(`${current.missingStreak} narrative ${current.missingStreak === 1 ? 'reply is' : 'replies are'} missing scene metadata. ${current.scene ? 'The last established scene is retained with its source cutoff.' : 'No established scene is available for selecting present characters and the current location.'}`);
  let memory = '';
  const render = () => {
    const history = raw.filter(m => selected.has(m.id)).map(m => ({ id:m.id,role:m.role,content:contentFor(m) }));
    if (memory) {
      if (mem.memoryBlock && mem.blockRole === 'user' && latest) {
        const target = history.find(m => m.id === latest.id);
        target.content = '<memory>\n'+memory+'\n</memory>\n\n'+target.content;
      } else {
        const index = history.findIndex(m => m.id === latest?.id);
        const at = Math.min(Math.max(0,history.length-mem.blockDepth),index < 0 ? history.length : index);
        history.splice(at,0,{ role:'system',content:memory });
      }
    }
    return [...head,...books,...history].map(({ role,content }) => ({ role,content }));
  };
  const cost = async () => FRAME+(await Promise.all(render().map(async m => FRAME+await count(m.content)))).reduce((a,b) => a+b,0);
  if (await cost() > limit) throw new Error('The opening story, summary and latest user message exceed the context budget. Increase the context limit or shorten required content.');
  const candidates = raw.filter(m => m.order > checkpoint && !required.has(m.id));
  const target = Math.max(0,settings.keepRecentMessagesAfterSummary ?? 10);
  const recentRaw = raw.filter(m => m.order > checkpoint);
  let targetStart = Math.max(0,recentRaw.length-target);
  // Complete the first retained turn when it fits. Tight budgets fall back to a suffix.
  const targetTurn = turns.turnById.get(recentRaw[targetStart]?.id);
  while (targetStart > 0 && turns.turnById.get(recentRaw[targetStart-1].id) === targetTurn) targetStart--;
  const targetIds = new Set(recentRaw.slice(targetStart).map(m => m.id));
  for (const m of [...candidates].reverse().filter(m => targetIds.has(m.id))) {
    selected.add(m.id);
    if (await cost() > limit) { selected.delete(m.id); break; }
  }
  const targetCount = recentRaw.slice(targetStart).length, retainedTarget = recentRaw.slice(targetStart).filter(m => selected.has(m.id)).length;
  if (retainedTarget < targetCount) warnings.push(`Recent window reduced from ${targetCount} to ${retainedTarget} messages to fit the request budget.`);
  let windowMode = mem.blockWindow ? 'fallback' : 'newest-first';
  const filtered = usableLore(opts.onlyRequiredWindow ? [] : opts.loreEntries ?? [],all,session,upTo);
  const selection = selectEntries(filtered.entries,mem,latest?.content ?? '',mem.scene ? current.scene : null);
  const skipped = [...filtered.skipped,...selection.skipped];
  const empty = { text:'',included:[],skipped:[],tokens:0,cut:0 }; let chars = empty, places = empty;
  const memoryText = () => mem.memoryBlock ? renderMemoryBlock({ scene:mem.scene ? current.scene : null,sceneFromTurn:turns.turnById.get(current.fromId),sceneFromOrder:current.fromOrder,staleScene:current.missingStreak>0,characters:chars,locations:places }) : [chars.text && 'Characters:\n'+chars.text,places.text && 'Places:\n'+places.text].filter(Boolean).join('\n\n');
  if (mem.memoryBlock) { memory = memoryText(); if (await cost() > limit) { memory = ''; warnings.push('Optional memory reminder omitted to preserve recent conversation.'); } }
  for (const book of ['facts','events','characters','locations']) {
    if (!selection.selected[book].length) continue;
    const beforeMemory = memory;
    const header = book === 'facts' ? prompts.factsHeader+'\n' : book === 'events' ? prompts.eventsHeader+'\nOpen threads:\nTimeline (oldest first, 999999 earlier events not shown):\n' : book === 'characters' ? 'Characters:\n' : 'Places:\n';
    const budget = Math.max(0,Math.min(mem.books[book].budget,limit-await cost())-await count(header)-FRAME);
    let fit = await fitBook(selection.selected[book],budget,count,{ protagonist:mem.protagonist,events:book === 'events' });
    const text = book === 'facts' ? renderFactsBlock(fit) : book === 'events' ? renderEventsBlock(fit) : fit.text;
    if (book === 'characters') chars = fit;
    else if (book === 'locations') places = fit;
    if (book === 'characters' || book === 'locations') memory = memoryText();
    else if (text) books.push({ role:'system',content:text });
    if (await cost() > limit) {
      if (book === 'characters') chars = empty;
      else if (book === 'locations') places = empty;
      else if (text) books.pop();
      memory = beforeMemory;
      skipped.push(...fit.included.map(e => ({ entryId:e.entry.id,book,name:e.entry.name,reason:'over budget' })));
      fit = empty;
    }
    skipped.push(...fit.skipped);
    if (fit.text && (book === 'facts' || book === 'events')) blocks.push({ key:book,label:book,tokens:await count(text)+FRAME,budget:mem.books[book].budget,cut:fit.cut });
    for (const e of fit.included) loaded.push({ entryId:e.entry.id,book,name:e.entry.name,reason:e.reason,tokens:e.tokens,linesSent:e.linesSent,linesCut:e.linesCut,draft:e.entry.draft,lineIds:[...e.lineIds] });
  }
  if (!opts.onlyRequiredWindow && mem.blockWindow && retainedTarget === targetCount && candidates.length) {
    const starts = [...new Set(candidates.map(m => turns.turnById.get(m.id)))].filter(t => (t-1)%mem.batchTurns === 0).sort((a,b) => a-b);
    for (const start of starts) {
      const aligned = candidates.filter(m => turns.turnById.get(m.id) >= start);
      if (!recentRaw.slice(targetStart).every(m => required.has(m.id) || aligned.some(a => a.id === m.id))) continue;
      const before = new Set(selected); for (const m of aligned) selected.add(m.id);
      if (await cost() <= limit) { windowMode = 'block'; break; }
      selected.clear(); for (const id of before) selected.add(id);
    }
  }
  // Only after lore may additional older conversation use the remaining budget.
  if (!opts.onlyRequiredWindow && windowMode !== 'block') for (const m of [...candidates].reverse()) {
    if (selected.has(m.id)) continue;
    selected.add(m.id); if (await cost() > limit) { selected.delete(m.id); break; }
  }
  const apiMessages = render(), actual = await cost();
  if (actual > limit) throw new Error('The fully rendered request exceeds the context budget.');
  const window = raw.filter(m => selected.has(m.id) && !anchorIds.has(m.id) && m.id !== latest?.id);
  const messageCost = async ms => (await Promise.all(ms.map(async m => await count(contentFor(m))+FRAME))).reduce((a,b) => a+b,0);
  blocks.push({ key:'anchor',label:'Opening exchange (historical background)',tokens:await messageCost(anchors.filter(m => m.id !== latest?.id)) });
  blocks.push({ key:'window',label:'Recent conversation',tokens:await messageCost(window),fromTurn:turns.turnById.get(window[0]?.id),toTurn:turns.turnById.get(window.at(-1)?.id),messages:window.length,mode:windowMode,step:mem.batchTurns,target:targetCount,retained:retainedTarget });
  if (latest) blocks.push({ key:'latest',label:'Latest user message',tokens:await messageCost([latest]) });
  if (memory) blocks.push({ key:'memory',label:'Memory block',tokens:mem.blockRole === 'user' && mem.memoryBlock && latest ? await count('<memory>\n'+memory+'\n</memory>\n\n'+contentFor(latest))-await count(contentFor(latest)) : await count(memory)+FRAME });
  blocks.push({ key:'framing',label:'Request framing estimate',tokens:FRAME });
  const uncovered = raw.filter(m => !selected.has(m.id) && m.order > checkpoint);
  const gaps = []; for (const m of uncovered) { const turn = turns.turnById.get(m.id); const last = gaps.at(-1); if (last && turn <= last.toTurn+1) { last.toTurn = turn; last.toOrder = m.order; } else gaps.push({ fromTurn:turn,toTurn:turn,fromOrder:m.order,toOrder:m.order }); }
  if (gaps.length) warnings.push(`${uncovered.length} messages are outside the request and not covered by the active summary. Memory notes may provide only partial coverage.`);
  if (session.memoryState?.paused) warnings.push('Memory updates paused. '+(session.memoryState.lastError ?? ''));
  return { apiMessages,usedTokens:actual,windowedCount:selected.size,droppedCount:uncovered.length,report:{ mode:memoryActive(mem) ? 'memory' : 'legacy',totals:{ input:actual,reserved:settings.maxResponseTokens,max:settings.maxContextTokens },blocks,loaded,skipped,scene:mem.scene && current.scene ? { ...current.scene,fromTurn:turns.turnById.get(current.fromId),fromOrder:current.fromOrder } : null,gap:gaps[0] ?? null,gaps,warnings } };
}
