import { prompts, renderPrompt } from './system-prompts.js';
import { normalizeMemory, memoryActive } from './memory-settings.js';
import { SCENE_RULE, latestScene, sceneTimeline, readSceneOutput } from './scene.js';
import { replyContract } from './reply-contract.js';
import { computeTurns } from './turns.js';
import { selectEntries, fitBook, renderFactsBlock, renderEventsBlock, renderMemoryBlock } from './lore-select.js';
import { planInjectionBlock, LEGACY_PLAN_LOSS_RULE } from './plan-parser.js';
import { CONTINUITY_RULE, usableLore, cutoffLabel, revisionOf, effectivelyPaused } from './continuity.js';
import {MESSAGE_FRAME_TOKENS as FRAME,requestInputLimit} from './request-budget.js';
function stripOcc(content) {
  const cleaned=content.replace(/<\s*(OOC|OCC)\b[^>]*>[\s\S]*?(?:<\/\s*\1\s*>|$)|<\/\s*(?:OOC|OCC)\s*>/gi, '');
  return cleaned.trim() ? cleaned : content;
}
// Memory mode uses additive message costs and renders the final wire request once.
export async function buildMemoryContext(session, settings, opts, { count, adRule, normalizeAd }) {
  const mem = normalizeMemory(session.memory), limit = requestInputLimit(settings);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Context limit must leave space for the request after reserving the reply.');
  const all = opts.messages, upTo = opts.upToOrder ?? Infinity;
  const raw = [...new Map(all.filter(m => ['user','assistant'].includes(m.role) && m.order < upTo && (m.role==='user' ? normalizeAd(m.content) : readSceneOutput(m.content).clean).trim()).map(m => [m.id,m])).values()].sort((a,b) => a.order-b.order);
  if (opts.draftText?.trim() || opts.placeholderLatest) raw.push({ id:'__memory_draft',order:(raw.at(-1)?.order ?? 0)+1,role:'user',content:opts.draftText ?? '' });
  const byId=new Map(raw.map(m=>[m.id,m]));
  const turns = computeTurns(raw), current = mem.scene ? latestScene(raw,Infinity,mem.startingScene) : {scene:null,missingStreak:0};
  const firstUser = raw.find(m => m.role === 'user'), firstAssistant = firstUser && raw.find(m => m.role === 'assistant' && m.order > firstUser.order), latest = raw.findLast(m => m.role === 'user');
  const anchors = [firstUser,firstAssistant].filter(Boolean), anchorIds = new Set(anchors.map(m => m.id));
  const required = new Set(anchorIds);
  if (latest) required.add(latest.id);
  if (opts.requireLatestUser && !latest) throw new Error('No user message is available for this request.');
  let narrator = (settings.narratorSystemPrompt || '').replace(LEGACY_PLAN_LOSS_RULE, '');
  const planOn=!!session.longTermPlan?.trim();
  const system=[narrator,adRule,CONTINUITY_RULE,planInjectionBlock(session.longTermPlan),planOn ? prompts.planThread : '',mem.scene ? SCENE_RULE(mem.protagonist) : ''].filter(Boolean).join('\n\n');
  const reminder=mem.scene ? (planOn ? prompts.sceneReminderPlan : prompts.sceneReminder) : '';
  const blocks=[{key:'system',label:'Instructions and fixed author plan',tokens:await count(system)+FRAME}];
  let summaryText='';
  let summary = session.activeSummaryMessageId && (session.breakpointOrder ?? 0) < upTo ? all.find(m => m.id === session.activeSummaryMessageId && !m.needsReview) : null;

  const checkpoint = summary ? (summary.coveredRange?.toOrder ?? session.breakpointOrder ?? 0) : 0;
  if (summary) {
    const content = renderPrompt(prompts.historicalSummary, { CUTOFF: cutoffLabel({ order:checkpoint,turn:summary.cutoffTurn }), SUMMARY: summary.content });
    summaryText=content; blocks.push({ key:'summary',label:'Summary through message '+checkpoint,tokens:await count(content) });
  }
  const timeline=mem.scene ? sceneTimeline(raw,{startingScene:mem.startingScene}) : new Map();
  const contentCache=new Map();
  const contentFor = (m,{gap=false}={}) => {
    const key=m.id+'|'+gap;if(contentCache.has(key))return contentCache.get(key);
    let text = m.role === 'assistant' ? readSceneOutput(normalizeAd(m.content)).clean : normalizeAd(m.content);
    if (m.role === 'assistant' && mem.scene && !m.ooc) {
      if (session.longTermPlan?.trim() && m.planThread) text+='\n<plan_thread>'+m.planThread+'</plan_thread>';
      const effective=timeline.get(m.id)?.effective;
      if (effective) text+='\n<scene>'+effective+'</scene>';
    }
    if (m.id !== latest?.id) text=stripOcc(text);
    if (gap && anchorIds.has(m.id) && m.id!==latest?.id) text=renderPrompt(prompts.openingExchange,{TURN:turns.turnById.get(m.id),CONTENT:text});
    contentCache.set(key,text);return text;
  };
  const selected = new Set(required), books = [], loaded = [], warnings = [];
  const contract = mem.scene && mem.replyContract !== 'off' ? replyContract(mem.protagonist,session.longTermPlan) : '';
  if (contract) blocks.push({ key:'replyContract',label:'Current reply contract',tokens:await count(contract)+FRAME });
  if (mem.scene && current.missingStreak > 0) warnings.push('Recent narrative has missing scene metadata; the previous scene is retained.');
  let memory = '';
  const gapInfo=() => {
    if(selected.size===raw.length)return '';
    const covered=!!summaryText && checkpoint>(anchors.at(-1)?.order ?? 0);
    return covered ? (raw.some(m=>!selected.has(m.id) && m.order>checkpoint) ? prompts.omittedTurnsPartial : prompts.omittedTurnsSummary) : prompts.omittedTurns;
  };
  const render = () => {
    const gap=gapInfo();
    const history=raw.filter(m=>selected.has(m.id)).map(m=>({id:m.id,role:m.role,content:contentFor(m,{gap:!!gap})}));
    if(gap) history.splice(history.filter(m=>anchorIds.has(m.id) && m.id!==latest?.id).length,0,{role:'system',content:gap});
    const userMemory=memory && mem.memoryBlock && mem.blockRole==='user' && latest;
    if(memory && !userMemory) {
      const li=history.findIndex(m=>m.id===latest?.id);
      let at=Math.min(Math.max(0,history.length-mem.blockDepth),li<0 ? history.length : li);
      while(at<history.length && history[at].role!=='user') at++;
      history.splice(at,0,{role:'system',content:memory});
    }
    if(latest) {
      const i=history.findIndex(m=>m.id===latest.id);
      if(userMemory) history[i].content='<memory>\n'+memory+'\n</memory>\n\n'+history[i].content;
      if(contract && mem.replyContract==='user') history[i].content+='\n\n'+contract;
      if(reminder) history[i].content+='\n\n'+reminder;
      if(contract && mem.replyContract==='system') history.splice(i,0,{role:'system',content:contract});
    }
    return [{role:'system',content:[system,summaryText,...books].filter(Boolean).join('\n\n')},...history].map(({role,content})=>({role,content}));
  };
  const messageCosts=new Map();
  const costOf=async(m,gap)=>{const key=m.id+'|'+gap;if(!messageCosts.has(key))messageCosts.set(key,await count(contentFor(m,{gap}))+FRAME);return messageCosts.get(key);};
  const cost=async()=>{
    const gap=gapInfo(),userMemory=memory && mem.memoryBlock && mem.blockRole==='user' && latest;
    let total=FRAME+FRAME+await count([system,summaryText,...books].filter(Boolean).join('\n\n'));
    for(const id of selected) {
      const m=byId.get(id);
      if(m.id!==latest?.id){const key=m.id+'|'+!!gap;total+=messageCosts.has(key) ? messageCosts.get(key) : await costOf(m,!!gap);continue;}
      let content=contentFor(m,{gap:!!gap});
      if(m.id===latest?.id){if(userMemory)content='<memory>\n'+memory+'\n</memory>\n\n'+content;if(contract && mem.replyContract==='user')content+='\n\n'+contract;if(reminder)content+='\n\n'+reminder;}
      total+=FRAME+await count(content);
    }
    if(gap)total+=FRAME+await count(gap);
    if(memory && !userMemory)total+=FRAME+await count(memory);
    if(contract && mem.replyContract==='system' && latest)total+=FRAME+await count(contract);
    return total;
  };
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
  const selection = selectEntries(filtered.entries,mem,latest?.content ?? '',mem.scene ? current.scene : null,raw.filter(m => m.role==='assistant' && !m.ooc && m.order < (latest?.order ?? Infinity)).slice(-2).map(m => readSceneOutput(m.content).clean).join('\n'));
  const skipped = [...filtered.skipped,...selection.skipped];
  const empty = { text:'',included:[],skipped:[],tokens:0,cut:0 }; let chars = empty, places = empty;
  const memoryText = () => mem.memoryBlock ? renderMemoryBlock({ scene:mem.scene ? current.scene : null,sceneFromTurn:turns.turnById.get(current.fromId),sceneFromOrder:current.fromOrder,staleScene:current.missingStreak>0,characters:chars,locations:places }) : [chars.text && 'Characters:\n'+chars.text,places.text && 'Places:\n'+places.text].filter(Boolean).join('\n\n');
  if (mem.memoryBlock) { memory = memoryText(); if (await cost() > limit) { memory = ''; warnings.push('Optional memory reminder omitted to preserve recent conversation.'); } }
  for (const book of ['facts','events','characters','locations']) {
    if (!selection.selected[book].length) continue;
    const beforeMemory = memory;
    const header = book === 'facts' ? prompts.factsHeader+'\n' : book === 'events' ? prompts.eventsHeader+'\nOpen threads:\nTimeline (oldest first, 999999 earlier events not shown):\n' : book === 'characters' ? 'Characters:\n' : 'Places:\n';
    const budget = Math.max(0,Math.min(mem.books[book].budget,limit-await cost())-await count(header)-FRAME);
    let fit = await fitBook(selection.selected[book],budget,count,{ protagonist:mem.protagonist,events:book === 'events',provenance:true });
    const text = book === 'facts' ? renderFactsBlock(fit) : book === 'events' ? renderEventsBlock(fit,{provenance:true}) : fit.text;
    if (book === 'characters') chars = fit;
    else if (book === 'locations') places = fit;
    if (book === 'characters' || book === 'locations') memory = memoryText();
    else if (text) books.push(text);
    if (await cost() > limit) {
      if (book === 'characters') chars = empty;
      else if (book === 'locations') places = empty;
      else if (text) books.pop();
      memory = beforeMemory;
      skipped.push(...fit.included.map(e => ({ entryId:e.entry.id,book,name:e.entry.name,reason:'over budget' })));
      fit = empty;
    }
    skipped.push(...fit.skipped);
    if(fit.userLinesCut)warnings.push(`${fit.userLinesCut} user-written lore lines could not fit in the ${book} budget.`);
    if (fit.text && (book === 'facts' || book === 'events')) blocks.push({ key:book,label:book,tokens:await count(text),budget:mem.books[book].budget,cut:fit.cut });
    for (const e of fit.included) loaded.push({ entryId:e.entry.id,book,name:e.entry.name,reason:e.reason,tokens:e.tokens,linesSent:e.linesSent,linesCut:e.linesCut,draft:e.entry.draft,lineIds:[...e.lineIds] });
  }
  if (!opts.onlyRequiredWindow && mem.blockWindow && retainedTarget === targetCount && candidates.length) {
    const ts=candidates.map(m=>turns.turnById.get(m.id)).filter(Number.isFinite),starts=[];
    for(let k=Math.floor((Math.min(...ts)-1)/mem.batchTurns);k*mem.batchTurns+1<=Math.max(...ts);k++)starts.push(k*mem.batchTurns+1);
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
  const apiMessages=render(),actual=FRAME+(await Promise.all(apiMessages.map(async m=>FRAME+await count(m.content)))).reduce((a,b)=>a+b,0);
  if(actual!==await cost())throw new Error('Context cost accounting mismatch.');
  if (actual > limit) throw new Error('The fully rendered request exceeds the context budget.');
  const window = raw.filter(m => selected.has(m.id) && !anchorIds.has(m.id) && m.id !== latest?.id);
  const messageCost = async ms => (await Promise.all(ms.map(async m => await count(contentFor(m,{gap:!!gapInfo()}))+FRAME))).reduce((a,b) => a+b,0);
  blocks.push({ key:'anchor',label:'Opening exchange (historical background)',tokens:await messageCost(anchors.filter(m => m.id !== latest?.id)) });
  blocks.push({ key:'window',label:'Recent conversation',tokens:await messageCost(window),fromTurn:turns.turnById.get(window[0]?.id),toTurn:turns.turnById.get(window.at(-1)?.id),messages:window.length,mode:windowMode,step:mem.batchTurns,target:targetCount,retained:retainedTarget });
  if (latest) blocks.push({ key:'latest',label:'Latest user message',tokens:await messageCost([latest]) });
  if (memory) blocks.push({ key:'memory',label:'Memory block',tokens:mem.blockRole === 'user' && mem.memoryBlock && latest ? await count('<memory>\n'+memory+'\n</memory>\n\n'+contentFor(latest))-await count(contentFor(latest)) : await count(memory)+FRAME });
  if(reminder) blocks.push({key:'reminder',label:'Scene reminder',tokens:await count('\n\n'+reminder)});
  if(gapInfo()) blocks.push({key:'gap',label:'Omitted turns marker',tokens:await count(gapInfo())+FRAME});
  blocks.push({key:'framing',label:'Request framing and section joins',tokens:actual-blocks.reduce((n,b)=>n+b.tokens,0)});
  const uncovered = raw.filter(m => !selected.has(m.id) && m.order > checkpoint);
  const gaps = []; for (const m of uncovered) { const turn = turns.turnById.get(m.id); const last = gaps.at(-1); if (last && turn <= last.toTurn+1) { last.toTurn = turn; last.toOrder = m.order; } else gaps.push({ fromTurn:turn,toTurn:turn,fromOrder:m.order,toOrder:m.order }); }
  if (gaps.length) warnings.push(`${uncovered.length} messages are outside the request and not covered by the active summary. Memory notes may provide only partial coverage.`);
  if (effectivelyPaused(session.memoryState)) warnings.push('Memory updates paused. '+(session.memoryState.lastError ?? ''));
  return { apiMessages,usedTokens:actual,windowedCount:selected.size,droppedCount:uncovered.length,report:{ mode:memoryActive(mem) ? 'memory' : 'legacy',totals:{ input:actual,reserved:settings.maxResponseTokens,max:requestInputLimit(settings) },blocks,loaded,skipped,scene:mem.scene && current.scene ? { ...current.scene,fromTurn:turns.turnById.get(current.fromId),fromOrder:current.fromOrder } : null,gap:gaps[0] ?? null,gaps,warnings } };
}
