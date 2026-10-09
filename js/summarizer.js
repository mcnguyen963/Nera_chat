import {memoryActive,normalizeMemory} from './memory-settings.js';
import {requestInputLimit} from './request-budget.js';
import { prompts, renderPrompt } from './system-prompts.js';
import { CONTINUITY_RULE, summarySource } from './continuity.js';
import { computeTurns, formatTurnsTranscript } from './turns.js';
import { isAcceptedTurn, lastUserOrderOf } from './turn-review.js';
// Rolling summarization (spec §8). The new summary always folds in the old summary
// plus everything since the last breakpoint; only the newest summary is referenced by
// the session going forward — older summary docs remain in the log as history.
//
// Firestore optimization: opts.messages lets the caller pass its cached
// checkpoint-to-present message list; the summary message + session pointer update
// are committed in ONE transaction (1 read + 2 writes instead of 2 reads + 3 writes).

import { getMessages, getCheckpointMessages, addMessage, newMessageId } from "./messages.js";
import { chatCompletion } from "./llm-client.js";
import { buildContextForRequest, computeContextUsage, MESSAGE_FRAME_TOKENS, REQUEST_FRAME_TOKENS } from "./context-builder.js";
import { countTokens } from "./tokenizer.js";

const CHUNK_TOKEN_BUDGET_DEFAULT = 250000;

// The summarizer has its own output budget (summarizerMaxTokens), independent
// of the chat's maxResponseTokens, so long histories can be captured fully.
function summarizerSettings(settings, outputCapacity) {
  const contextLimit = Number(settings.maxContextTokens);
  if (!Number.isFinite(contextLimit) || contextLimit < 1024) {
    throw new Error("Summarization needs a context limit of at least 1024 tokens.");
  }
  const maxResponseTokens = Math.min(
    settings.summarizerMaxTokens ?? 20000, outputCapacity
  );
  // Summaries need their output budget for facts, not the chat profile's thinking.
  return { ...settings, maxResponseTokens, reasoning: { ...settings.reasoning, enabled: false } };
}

export function formatAsTranscript(msgs) { return formatTurnsTranscript(msgs); }

const summaryRunning=new Set();
export function planSummary(session,settings,messages,{maxChunks=Infinity,force=true,full=false,running=false,urgent=false}={}) {
  if(running)return {skip:'running'};
  if(!force)return {skip:'not-needed'};
  const all=[...messages].sort((a,b)=>a.order-b.order),raw=all.filter(m=>m.role!=='summary'),turns=computeTurns(raw),N=Math.max(0,settings.keepRecentMessagesAfterSummary ?? 10);
  if(raw.length<=N)return {skip:'nothing-to-fold'};
  let recentStart=raw.length-N,firstRecentTurn=turns.turnById.get(raw[recentStart]?.id);
  while(recentStart>0 && turns.turnById.get(raw[recentStart-1].id)===firstRecentTurn)recentStart--;
  const cutoff=raw[recentStart-1]?.order ?? 0,prior=!full && all.some(m=>m.id===session.activeSummaryMessageId),fromOrder=prior ? session.breakpointOrder ?? 0 : 0;
  const firstUser=raw.find(m=>m.role==='user'),firstAssistant=firstUser && raw.find(m=>m.role==='assistant' && m.order>firstUser.order),opening=new Set([firstUser?.id,firstAssistant?.id]);
  let toFold=raw.filter(m=>m.order>fromOrder && m.order<=cutoff && !opening.has(m.id));
  if(session.memory?.scene){const pending=toFold.find(m=>m.role==='assistant' && !isAcceptedTurn(m,{lastUserOrder:lastUserOrderOf(raw)}));if(pending){toFold=toFold.filter(m=>turns.turnById.get(m.id)<turns.turnById.get(pending.id));if(!toFold.length)return {skip:'pending-reply'};}}
  while(toFold.length && toFold.at(-1).role!=='assistant')toFold.pop();
  if(!toFold.length)return {skip:'nothing-to-fold'};
  const groups=[];for(const m of toFold){const turn=turns.turnById.get(m.id);if(groups.at(-1)?.turn!==turn)groups.push({turn,messages:[]});groups.at(-1).messages.push(m);}
  const chunks=[];let chunk=[],tokens=0;for(const group of groups){const n=group.messages.reduce((sum,m)=>sum+(m.tokenCount ?? new TextEncoder().encode(m.content ?? '').length),0);if(chunk.length && tokens+n>(settings.summarizerChunkTokens ?? CHUNK_TOKEN_BUDGET_DEFAULT)){chunks.push(chunk);chunk=[];tokens=0;}chunk.push(...group.messages);tokens+=n;}if(chunk.length)chunks.push(chunk);
  const chosen=chunks.slice(0,maxChunks);return {toFold:chosen.flat(),chunks:chosen,newBreakpointOrder:chosen.at(-1).at(-1).order,turns,urgent};
}
export async function runSummarization(session, settings, opts = {}) {
  if(summaryRunning.has(session.id))return {skipped:true,reason:'A summary is already running.'};
  summaryRunning.add(session.id);
  try{return await runSummary(session,settings,opts);}finally{summaryRunning.delete(session.id);}
}
async function runSummary(session,settings,opts) {
  session=structuredClone(session);
  const expectedSource=summarySource(session),all=structuredClone(opts.messages ?? (opts.full ? await getMessages(session.id) : await getCheckpointMessages(session)));
  // The running gate belongs to this call; planning is pure over the captured history.
  const plan=planSummary(session,settings,all,{full:opts.full});
  if(plan.skip)return {skipped:true,reason:plan.skip==='pending-reply' ? 'Review flagged replies before summarizing their turns.' : 'Nothing new to fold in since the last breakpoint.'};
  const {toFold,turns}=plan;let newBreakpointOrder=plan.newBreakpointOrder;
  // Prior summary is already in `all` — no extra getMessage() read.
  const priorSummary = opts.full
    ? null
    : session.activeSummaryMessageId
      ? all.find((m) => m.id === session.activeSummaryMessageId)?.content ?? null
      : null;

  const probe = await buildContextForRequest({ ...session,activeSummaryMessageId:null,breakpointOrder:0 },settings,{ ...opts,messages:all,loreEntries:[],onlyRequiredWindow:true,requireLatestUser:true });
  const summaryHeaderCost = await countTokens(renderPrompt(prompts.historicalSummary, { CUTOFF: 'message order '+newBreakpointOrder, SUMMARY: '' }))+MESSAGE_FRAME_TOKENS+32;
  const capacity = Math.floor(requestInputLimit(settings)-probe.usedTokens-summaryHeaderCost);
  if (capacity < 64 || probe.report.warnings.some(w => w.startsWith('Recent window reduced'))) throw new Error('No room for a summary and the required recent conversation; checkpoint was not changed.');
  const requestSettings = summarizerSettings(settings,capacity);
  const inputLimit = requestInputLimit({...settings,maxResponseTokens:requestSettings.maxResponseTokens});
  const frameTokens = MESSAGE_FRAME_TOKENS * 2 + REQUEST_FRAME_TOKENS;
  const chunkLimit = settings.summarizerChunkTokens ?? CHUNK_TOKEN_BUDGET_DEFAULT;
  let running = priorSummary ? "Previous summary:\n" + priorSummary + "\n\n" : "";

  const summaryPrompt = (settings.summarizerSystemPrompt || '')+(memoryActive(normalizeMemory(session.memory)) ? '\n\n'+CONTINUITY_RULE : '');
  const detailDirective = '\n\n'+renderPrompt(prompts.summaryOutput, { MAX_OUTPUT_TOKENS: requestSettings.maxResponseTokens });

  let content = null;
  let offset = 0;
  let part = 0;
  while (offset < toFold.length) {
    const chunk = [];
    const prefix = running + "New events to fold in:\n";
    const fixedTokens = await countTokens(summaryPrompt + "\n" + prefix + detailDirective) + frameTokens;
    let transcriptTokens = 0;
    let i=offset;
    while(i<toFold.length) {
      const turn=turns.turnById.get(toFold[i].id),group=[];
      while(i<toFold.length && turns.turnById.get(toFold[i].id)===turn)group.push(toFold[i++]);
      const groupTokens=(await Promise.all(group.map(m=>countTokens(`${m.role==='user'?'User':'Assistant'}: ${m.content}\n\n`)))).reduce((a,b)=>a+b,0);
      if(fixedTokens+transcriptTokens+groupTokens>inputLimit || chunk.length && transcriptTokens+groupTokens>chunkLimit)break;
      chunk.push(...group);transcriptTokens+=groupTokens;
    }
    let summarizerInput=prefix+formatAsTranscript(chunk)+detailDirective;
    while(chunk.length && await countTokens(summaryPrompt+'\n'+summarizerInput)+frameTokens>inputLimit){const turn=turns.turnById.get(chunk.at(-1).id);while(chunk.length && turns.turnById.get(chunk.at(-1).id)===turn)chunk.pop();summarizerInput=prefix+formatAsTranscript(chunk)+detailDirective;}
    if(!chunk.length)throw new Error('A story turn or previous summary is too large for the summarizer context budget. Increase the context limit or shorten it.');
    part++;
    opts.onProgress?.(offset + chunk.length < toFold.length || part > 1, part, null);

    const r = await chatCompletion({
      settings: requestSettings,
      messages: [
        { role: "system", content: summaryPrompt },
        { role: "user", content: summarizerInput },
      ],
      onDelta: opts.onDelta,
      onReasoning: opts.onReasoning,
      signal:opts.signal,
      allowTruncated: true,
    });
    if (r.finishReason === 'length') throw new Error('The summary hit the output limit; the checkpoint was not changed. Raise Summarizer max tokens or use smaller summary chunks.');
    await opts.validateSource?.(expectedSource);
    content = r.content;
    if (!content?.trim()) throw new Error("The summarizer returned an empty summary; checkpoint was not changed.");
    // Each chunk's summary becomes the "previous summary" for the next chunk.
    running = "Previous summary:\n" + content.trim() + "\n\n";
    offset += chunk.length;
    newBreakpointOrder=chunk.at(-1).order;
    if(part>=(opts.maxChunks ?? Infinity))break;
  }

  const summaryId = newMessageId();
  const summaryMessage = { id:summaryId,order:(all.at(-1)?.order ?? 0)+1,role:'summary',content,coveredRange:{fromOrder:all.find(m=>m.id===session.activeSummaryMessageId)?.coveredRange?.fromOrder ?? (session.activeSummaryMessageId && !opts.full ? 1 : toFold[0].order),toOrder:newBreakpointOrder},sourceRevision:expectedSource.historyRevision,cutoffTurn:turns.turnById.get(toFold[Math.max(0,offset-1)]?.id) };
  const candidate = await buildContextForRequest({ ...session,activeSummaryMessageId:summaryId,breakpointOrder:newBreakpointOrder },settings,{ ...opts,messages:[...all,summaryMessage],requireLatestUser:true });
  if (candidate.report.warnings.some(w => w.startsWith('Recent window reduced'))) throw new Error('Candidate summary displaced required recent conversation; checkpoint was not changed.');
  const newMsg = await addMessage(session.id,summaryMessage,{ id:summaryId,expectedSource,sessionUpdate:{ activeSummaryMessageId:summaryId,breakpointOrder:newBreakpointOrder } });

  return {
    skipped: false,
    summaryId: newMsg.id,
    newBreakpointOrder,
    foldedCount: offset,
    summaryMessage:{ ...summaryMessage,...(newMsg.message ?? Object.fromEntries(Object.entries(newMsg).filter(([key])=>key!=='session'))) },
    historyRevision:newMsg.historyRevision,
  };
}

// Auto-trigger check (spec §8.1): fires after each assistant reply is saved.
export async function shouldAutoSummarize(session, settings, messages = null,opts={}) {
  if (settings.autoSummarizationEnabled !== true) return false;
  const { overThreshold, droppedCount } = await computeContextUsage(session, settings, messages,opts);
  return overThreshold || droppedCount > 0;
}
