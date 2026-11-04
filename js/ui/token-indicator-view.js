export function createTokenIndicatorView(ctx) {
function applyIndicator(record) {
  ctx.refreshTokenDisplayMeta();
  const view=ctx.tokenUsageSnapshot(),max=view.max,settings=ctx.effectiveActiveSettings();
  const lastSent=record.kind==='provider' || record.kind==='sent-estimate',estimated=record.kind!=='provider';
  ctx.el.contextLabel.title=(lastSent ? ctx.indicatorHint : record.kind==='manual' ? 'Manual current-context calculation, excluding unsent input.' : 'Cached context estimate, excluding unsent input.')+(view.contextChanged ? ' Context changed since this count.' : '')+
    (record.droppedCount>0 && !settings.autoSummarizationEnabled ? ' Older turns no longer fit. Turn on auto-summary or run Summarize to keep them in memory.' : '');
  const ring=ctx.contextRingPresentation({used:record.tokens,max});
  ctx.el.contextFill.style.strokeDasharray=ring.dash;ctx.el.contextFill.style.stroke=ring.color;
  ctx.el.contextFill.classList.toggle('over',record.tokens>=max*settings.autoSummaryThresholdPercent/100);
  ctx.el.contextThreshold.style.left=settings.autoSummaryThresholdPercent+'%';
  ctx.el.contextLabel.textContent=`${record.tokens.toLocaleString()} input / ${max.toLocaleString()} tokens`+
    (lastSent ? ' · last sent' : record.kind==='manual' ? ' · manual' : '')+(estimated ? ' · estimate' : ' · provider')+
    (record.droppedCount>0 ? ` · ${record.droppedCount} ${settings.autoSummarizationEnabled ? 'out of window' : 'turns not sent'}` : '')+
    (view.contextChanged ? ' · context changed' : '')+(record.recentOnly ? ' · recent history only' : '');
  const indicator=document.getElementById('context-indicator');
  indicator.setAttribute('aria-label','View context: '+ctx.el.contextLabel.textContent+'. '+ctx.el.contextLabel.title);
  indicator.title=ctx.el.contextLabel.textContent+'. '+ctx.el.contextLabel.title;ctx.updateMemoryChip();
}

return applyIndicator;
}
