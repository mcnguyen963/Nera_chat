// A summary owns history/checkpoint metadata, never memory or lore state.
// Its transaction result can arrive after a newer memory save reached this tab.
const historyFields = ['nextOrder','nextNarratorTurn','activeChunkId','activeChunkBytes','activeChunkCount','summaryCoverageOrder','summaryCoverageUnknown'];
const time=value=>value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : typeof value==='number' ? value : typeof value?.seconds==='number' ? value.seconds*1000+(value.nanoseconds??0)/1000000 : -Infinity);
export function mergeSummaryResult(current,result) {
  if(result.skipped)return current;
  const saved=result.session ?? {},revision=result.historyRevision ?? saved.historyRevision ?? current.historyRevision ?? 0;
  const next={...current};
  if(revision>=(current.historyRevision ?? 0)) {
    for(const field of historyFields)if(field in saved)next[field]=saved[field];
    if('updatedAt' in saved && time(saved.updatedAt)>=time(current.updatedAt))next.updatedAt=saved.updatedAt;
    next.historyRevision=revision;
    next.activeSummaryMessageId=result.summaryId;
    next.breakpointOrder=result.newBreakpointOrder;
  }
  return next;
}
