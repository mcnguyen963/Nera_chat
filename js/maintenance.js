export function pickMaintenance({overwrite,needsRecovery,summary,memoryDue,memoryRunning,summaryRunning,memoryDeferrals=0}) {
  if(needsRecovery)return 'recovery';
  if(overwrite)return null;
  const memory=memoryDue && !memoryRunning,summarize=summary && !summaryRunning;
  if(summarize && summary.urgent && !(memory && memoryDeferrals>=2))return 'summary';
  if(memory)return 'memory';
  if(summarize)return 'summary';
  return null;
}
