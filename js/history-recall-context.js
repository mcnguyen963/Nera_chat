import {RECALL_BUDGET,RECALL_LIMIT,renderRecall} from './history-recall-core.js';
import {requestInputLimit,MESSAGE_FRAME_TOKENS} from './request-budget.js';

export async function addHistoricalRecall(base,recall,settings,count) {
  if(!recall || settings.narrationMode==='director')return base;
  const budget=Number.isFinite(settings.historyRecallBudget) ? Math.max(0,Math.min(15000,Math.floor(settings.historyRecallBudget))) : RECALL_BUDGET;
  const passageLimit=Number.isFinite(settings.historyRecallPassages) ? Math.max(1,Math.min(20,Math.floor(settings.historyRecallPassages))) : RECALL_LIMIT;
  const cap=Math.max(0,Math.min(budget,requestInputLimit(settings)-base.usedTokens));
  const included=[],omitted=[...(recall.omitted ?? [])];let text='',tokens=0;
  for(const row of (recall.passages ?? [])) {
    if(included.length>=passageLimit)break;
    if(included.some(prior=>prior.messageId===row.messageId && prior.text.includes(row.text))){
      omitted.push({messageId:row.messageId,reason:'overlapping recall passage'});continue;
    }
    const next=renderRecall([...included,row]),cost=await count(next)+MESSAGE_FRAME_TOKENS;
    if(cost>cap){omitted.push({messageId:row.messageId,reason:'recall token budget'});continue;}
    included.push(row);text=next;tokens=cost;
  }
  // Select by relevance, but present historical excerpts in source order so the
  // narrator can distinguish earlier conditions from later changes.
  const chronological=()=>[...included].sort((a,b)=>(a.order ?? 0)-(b.order ?? 0) || (a.start ?? 0)-(b.start ?? 0));
  if(included.length){
    text=renderRecall(chronological());tokens=await count(text)+MESSAGE_FRAME_TOKENS;
    while(tokens>cap && included.length){const removed=included.pop();omitted.push({messageId:removed.messageId,reason:'recall token budget'});text=included.length ? renderRecall(chronological()) : '';tokens=included.length ? await count(text)+MESSAGE_FRAME_TOKENS : 0;}
  }
  const report={...base.report,recall:{status:recall.status,coverage:recall.coverage ?? 0,indexedPassages:recall.indexedPassages ?? 0,persisted:recall.persisted ?? false,modelMismatch:!!recall.modelMismatch,incompatibleDimensions:recall.incompatibleDimensions ?? 0,tokens,cap,selected:chronological().map(r=>({messageId:r.messageId,order:r.order,role:r.role,start:r.start,end:r.end,methods:r.methods})),omitted}};
  if(!included.length)return {...base,report};
  // Keep every existing API message byte-for-byte, including the final action
  // and its scene/reply instructions. This adds exactly one user data message.
  const apiMessages=[base.apiMessages[0],{role:'user',content:text},...base.apiMessages.slice(1)];
  const usedTokens=base.usedTokens+tokens;
  report.totals={...report.totals,input:usedTokens};report.blocks=[...report.blocks,{key:'historicalRecall',label:'Historical recall',tokens}];
  const result={...base,apiMessages,usedTokens,report};
  if(base.inspection)result.inspection={sections:{...base.inspection.sections,historicalRecall:text},messages:[{id:'__historical_recall',role:'user',content:text,requestIndex:1,source:'Historical recall'},...base.inspection.messages.map(m=>({...m,requestIndex:m.requestIndex+1}))]};
  if(base.entries)result.entries=[...base.entries,{role:'user',content:text,source:'Historical recall',tokens}];
  if(base.contributions)result.contributions=[...base.contributions,{source:'Historical recall',tokens}];
  return result;
}
