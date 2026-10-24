import { renderCoreEditor } from './character-core-editor.js';
import { saveEntry } from '../lore-store.js';
import { currentUid } from '../auth.js';
import {computeTurns} from '../turns.js';
import {normalizeMemory, anyMemory} from '../memory-settings.js';
import {BOOK_LABELS} from '../lore-format.js';
import {state} from '../state.js';
import {tokenUsageSnapshot,calculateCurrentTokenPreview} from './chat-view.js';
import {lastRawAnswer, updateNow, isRunning} from '../memory-updater.js';
import {node, button, sheet, subSheet, copy, toast} from './memory-ui.js';
let open = false, version = 0, viewedSession, viewedOwner;
const expanded = new Map(), scrollPositions = new Map();
let viewMode='cached',currentViewSource=null;

export function initContextViewer() {
  document.addEventListener('context-details', openContextViewer);
  for (const event of ['lore-changed','memory-refresh','session-changed','settings-changed','story-settings-changed','turn-finished','token-usage-changed']) {
    document.addEventListener(event, () => {
      if(!open)return;
      const view=tokenUsageSnapshot();
      if(viewMode==='current' && currentViewSource?.owner===view.owner && currentViewSource?.sid===view.sid && currentViewSource?.key===view.contextKey)return;
      void render();
    });
  }
}
export function openContextViewer() {
  if (open) return;
  open = true;
  sheet(document.getElementById('context-viewer'), 'TOKEN USAGE', {className:'context-sheet', close:() => {
    rememberView(); open = false; ++version; return true;
  }});
  // Opening reads cached telemetry only; expensive previews require a click.
  void render();
}
function rememberView() {
  const body = document.querySelector('#context-viewer .memory-content');
  if (!body) return;
  for (const d of body.querySelectorAll('details')) expanded.set(d.dataset.contextKey, !!d.open);
  scrollPositions.set('body', body.scrollTop);
  for (const e of body.querySelectorAll('.context-scroll')) scrollPositions.set(e.dataset.scrollKey, e.scrollTop);
}
function group(key, title, initiallyOpen = false, populate) {
  const details = node('details', null, 'context-section');
  details.dataset.contextKey = key;
  const summary = node('summary', title);
  summary.dataset.focusKey = key;
  details.append(summary);
  details.open = expanded.get(key) ?? initiallyOpen;
  summary.setAttribute('aria-expanded', String(details.open));
  let populated = false;
  const fill = () => {
    summary.setAttribute('aria-expanded', String(details.open));
    if (!details.open || populated || !populate) return;
    populated = true;
    populate(details);
  };
  details.addEventListener('toggle', fill);
  fill();
  return details;
}
function preview(key, title, text) {
  return group(key, title, false, d => {
    const pre = node('pre', typeof text==='function' ? text() : text, 'context-preview context-scroll');
    pre.dataset.scrollKey = key;
    pre.tabIndex = 0;
    pre.dataset.focusKey = key+'-text';
    d.append(pre);
    pre.scrollTop = scrollPositions.get(key) ?? 0;
  });
}
function messageList(parent, key, messages) {
  const list = node('div', null, 'context-turn-list context-scroll');
  list.dataset.scrollKey = key;
  for (const m of messages) {
    const title = `${m.requestIndex+1}. ${m.source ?? m.role} · ${m.role}` + (m.order != null ? ` · message ${m.order}` : '');
    list.append(preview(`${key}-${m.id ?? m.requestIndex}`, title, m.content));
  }
  parent.append(list);
  list.scrollTop = scrollPositions.get(key) ?? 0;
}
function textSection(body, key, title, text, empty) {
  const section = group(key, title);
  section.append(text ? preview(key+'-text', 'Read included text', text) : node('p', empty, 'muted'));
  body.append(section);
}
function replaceBody(dialog,body) {
  dialog.querySelector('.memory-content')?.remove();dialog.append(body);
  body.scrollTop=scrollPositions.get('body') ?? 0;
}
function renderCached() {
  viewMode='cached';currentViewSource=null;
  const dialog=document.querySelector('#context-viewer .sheet');if(!dialog || !open)return;
  const view=tokenUsageSnapshot();
  if(viewedSession!==view.sid || viewedOwner!==view.owner){
    viewedSession=view.sid;viewedOwner=view.owner;expanded.clear();scrollPositions.clear();
    dialog.querySelector('.memory-content')?.remove();
  }else rememberView();
  const focusKey=document.activeElement?.dataset?.focusKey;
  const body=node('div',null,'memory-content context-content'),overview=node('section',null,'context-overview');
  overview.append(node('h3','Overview'));
  const record=view.record;
  if(record){
    overview.append(node('p',`${record.tokens.toLocaleString()} input / ${view.max.toLocaleString()} tokens`,'context-total'));
    const source=record.kind==='provider' ? 'Last sent · provider input count' : record.kind==='sent-estimate' ? 'Last sent · local estimate' : 'Cached context estimate';
    overview.append(node('p',source+' · excludes unsent input','muted context-count-status'));
    overview.append(node('p',new Date(record.at).toLocaleString()+(record.modelId ? ' · '+record.modelId : ''),'muted'));
    if(view.contextChanged)overview.append(node('p',record.kind==='estimate' ? 'Context changed. The cached estimate is being updated.' : 'Context changed since last send. This remains the last request’s input count.','muted'));
    if(record.recentOnly)overview.append(node('p','Estimate covers the history available on this device.','muted'));
    if(record.report?.blocks?.length){
      const breakdown=group('tokens','Local token breakdown');
      breakdown.append(node('p','Local estimates from the prepared request; these may differ from the provider total.','muted'));
      for(const block of record.report.blocks){const row=node('div',null,'context-block-row');row.append(node('span',BOOK_LABELS[block.key] ?? block.label),node('span',block.tokens.toLocaleString()));breakdown.append(row);}
      overview.append(breakdown);
    }
  }else overview.append(node('p',!view.sid ? 'Open a story to see its token usage.' : view.error || 'Preparing a cached estimate…','muted context-count-status'));
  const calculate=button(view.previewCached ? 'View cached current preview' : 'Calculate current preview',async b=>{
    b.disabled=true;b.textContent='Calculating current preview…';await render({current:true});
  });
  calculate.dataset.focusKey='calculate-preview';calculate.disabled=!view.sid || view.busy || view.loading;
  overview.append(calculate);body.append(overview);
  const sent=view.sentContext;
  if(sent){
    const section=group('last-sent','Last sent request · '+new Date(sent.sentAt).toLocaleString(),false,d=>{
      if(sent.report?.characterSelection)characterReport(d,sent.report.characterSelection,'sent-character');
      if(sent.report?.recordSelection)recordReport(d,sent.report.recordSelection,'sent-records');
      d.append(preview('last-sent-json','Read exact serialized request body',()=>JSON.stringify(sent.requestBody,null,2)));
    });body.append(section);
  }else if(record?.kind!=='estimate' && record)body.append(node('p','The count is cached on this device. Full request text is available after the next send.','muted'));
  replaceBody(dialog,body);
  if(focusKey)[...body.querySelectorAll('summary,pre,button')].find(e=>e.dataset.focusKey===focusKey)?.focus({preventScroll:true});
}
async function render({current=false}={}) {
  if(!current){++version;renderCached();return;}
  const dialog=document.querySelector('#context-viewer .sheet');if(!dialog || !open)return;
  const run=++version,source=tokenUsageSnapshot();
  viewMode='current';currentViewSource={owner:source.owner,sid:source.sid,key:source.contextKey};
  let live;
  try {
    const previewResult=await calculateCurrentTokenPreview();
    const {built,countingMethod}=previewResult;live=previewResult.live;
    if (run !== version || !open || state.sessionId !== live.session.id) return;
    rememberView();
    const focusKey = document.activeElement?.dataset?.focusKey;
    const body = node('div', null, 'memory-content context-content');
    const r = built.report, sections = built.inspection.sections;
    const mem = normalizeMemory(live.session.memory);
    const overview = node('section', null, 'context-overview');
    const heading = node('div', null, 'context-overview-heading');
    const refresh = button('Last sent', () => render());
    refresh.dataset.focusKey = 'refresh';
    heading.append(node('h3', 'Overview'), refresh);
    overview.append(heading, node('p', `${r.totals.input.toLocaleString()} input / ${r.totals.max.toLocaleString()} tokens`, 'context-total'));
    const bar = node('div', null, 'context-segments');
    bar.setAttribute('aria-label', 'Estimated input token usage');
    for (const [i,b] of r.blocks.entries()) {
      const seg = node('span');
      seg.style.width = Math.max(0, 100*b.tokens/r.totals.max)+'%';
      seg.style.background = `hsl(0 0% ${Math.min(78, 35+i*4)}%)`;
      seg.title = b.label+': '+b.tokens; bar.append(seg);
    }
    overview.append(bar, node('p', 'Separate max reply: '+r.totals.reserved.toLocaleString(), 'muted'));
    const counted=countingMethod==='tokenizer';
    overview.append(node('p', (counted ? 'Tokenizer count' : 'Local estimate')+' · current preview · excludes unsent input', 'muted context-count-status'));
    if (live.providerUsage) overview.append(node('p', `Last sent request: provider counted ${live.providerUsage.promptTokens.toLocaleString()} input tokens (local estimate ${live.providerUsage.estimate.toLocaleString()}).`, 'muted'));
    for (const warning of r.warnings) overview.append(node('p', warning, 'memory-warning'));
    const breakdown = group('tokens', 'Token breakdown');
    for (const b of r.blocks) {
      const row = node('div', null, 'context-block-row');
      row.append(node('span', BOOK_LABELS[b.key] ?? b.label), node('span', b.tokens.toLocaleString()+(b.budget != null ? ' / '+b.budget.toLocaleString() : '')));
      breakdown.append(row);
    }
    overview.append(breakdown); body.append(overview);
    textSection(body, 'instructions', 'Instructions & story plan', sections.system, 'No instructions included.');
    if(sections.replyBrief)textSection(body,'reply-brief','Current reply brief',sections.replyBrief,'No Director contract yet.');
    textSection(body, 'summary', 'Story summary', sections.summary, 'No active summary.');

    const lore = group('lorebooks', 'Lorebooks', true);
    for (const [book,label] of Object.entries(BOOK_LABELS)) {
      const loaded = r.loaded.filter(e => e.book===book), skipped = r.skipped.filter(e => e.book===book);
      const bookGroup = group('book-'+book, `${label} · ${loaded.length} loaded · ${skipped.length} skipped`);
      if (!mem.lorebooks) bookGroup.append(node('p', 'Lorebooks are off for this story.', 'muted'));
      else if (!mem.books[book].on) bookGroup.append(node('p', 'This book is disabled.', 'muted'));
      else if (!loaded.length && !skipped.length) bookGroup.append(node('p', 'No cards selected for this request.', 'muted'));
      for (const [included,entries] of [[true,loaded],[false,skipped]]) for (const e of entries) {
        const card = node('div', null, 'context-card');
        card.append(button(e.name, () => {
          closeViewer();
          document.dispatchEvent(new CustomEvent('lorebooks', {detail:{entryId:e.entryId,book:e.book,newName:e.entryId ? null : e.name}}));
        }, 'lore-link'));
        if(e.phaseTitle)card.append(node('p','Phase: '+e.phaseTitle,'muted'));
        card.append(node('p', included ? `Loaded · ${e.reason} · ${e.tokens.toLocaleString()} tokens within this book${e.linesCut ? ' · '+e.linesCut+' older lines not sent' : ''}${e.draft ? ' · draft' : ''}` : e.reason==='no card' ? 'In scene, no card' : 'Not loaded — '+e.reason, 'muted'));
        if (e.ranking) {
          const {rank,priorityReason,mention} = e.ranking;
          const role = mention?.role === 'assistant' ? 'narrator' : mention?.role;
          const explanation = priorityReason === 'recent mention' ? `recent ${role ? role+' ' : ''}mention`
            : priorityReason === 'mentioned' ? `current ${role ? role+' ' : ''}input mention` : priorityReason;
          card.append(node('p', `Rank ${rank} · ${explanation}${mention ? ` · message ${mention.messageId ?? '?'} (order ${mention.order}, offset ${mention.offset})` : ''}`, 'muted'));
        }
        if (!included && e.reason.includes('over budget')) card.append(node('p', 'Excluded by token budget.', 'muted'));
        if (!included && e.text) card.append(preview('skipped-'+e.entryId+'-'+(e.lineId ?? e.section),'Read excluded source text',e.text));
        if (e.reason.startsWith('card limit')) card.append(button('Raise limit', () => {
          closeViewer(); document.dispatchEvent(new CustomEvent('memory-settings', {detail:{focus:'mem-'+book+'-maxCards'}}));
        }, 'btn small'));
        bookGroup.append(card);
      }
      const cards = live.entries.filter(e => e.book===book);
      const total = cards.reduce((n,e) => n+Object.values(e.sections).reduce((n,s) => n+(s.lines?.length ?? 0),0),0);
      const sent = loaded.reduce((n,e) => n+(e.linesSent ?? 0),0);
      const reasons = new Set(skipped.map(e => e.reason));
      if (loaded.some(e => e.linesCut)) reasons.add('book token budget');
      if (!mem.books[book].on) reasons.add('book disabled');
      if (total>sent && !reasons.size) reasons.add('not selected for this scene or memory disabled');
      bookGroup.append(node('p', `${sent} notes sent · ${total-sent} omitted${reasons.size ? ' · '+[...reasons].join('; ') : ''}`, 'context-coverage muted'));
      if (sections[book]) bookGroup.append(preview('book-'+book+'-text', 'Read included '+label.toLowerCase(), sections[book]));
      lore.append(bookGroup);
    }
    if(r.characterBudget)characterBudgetReport(lore,r.characterBudget);
    if (r.characterSelection) characterReport(lore,r.characterSelection,'next-character',live);
    if(r.recordSelection)recordReport(lore,r.recordSelection,'next-records');
    body.append(lore);
    if (live.sentContext) {
      const sent=live.sentContext,section=group('last-sent','Last sent request · '+new Date(sent.sentAt).toLocaleString());
      section.append(node('p','Captured at request serialization. This report stays with that request when the draft, lore or next-request preview changes.','muted'));
      if(sent.report?.replyBrief){section.append(preview('sent-reply-brief','Reply brief · exact sent text',sent.report.replyBrief.text),preview('sent-brief-sources','Reply brief sources and omissions',JSON.stringify(sent.report.replyBrief,null,2)));}
      if(sent.director){const d=sent.director;section.append(node('p',`Director: ${d.reused ? 'reused contract' : (d.usage?.prompt_tokens ?? d.report?.totals?.input ?? 0).toLocaleString()+' input tokens'} · ${d.elapsedMs ?? 0} ms. Narrator: ${sent.narratorUsage?.prompt_tokens?.toLocaleString() ?? 'usage unavailable'} input tokens · ${sent.narratorElapsedMs ?? 0} ms. Combined estimate: ${((d.reused ? 0 : d.report?.totals?.input ?? 0)+(sent.report?.totals?.input ?? 0)).toLocaleString()} input tokens.`, 'muted'));if(d.timings && !d.reused)section.append(node('p',Object.entries(d.timings).map(([key,value])=>({contextPreparationMs:'Prepare',providerMs:'Model',validationMs:'Validate',pendingPersistenceMs:'Save'}[key] ?? key)+': '+Math.round(value)+' ms').join(' · '),'muted'));if(d.usage?.cost!=null && !d.reused)section.append(node('p','Director cost: $'+Number(d.usage.cost).toFixed(6),'muted'));if(d.requestBody)section.append(preview('director-sent-json','Director serialized request',JSON.stringify(d.requestBody,null,2)));section.append(preview('director-contract','Director contract',JSON.stringify(d.contract,null,2)));}
      if(sent.report.characterBudget)characterBudgetReport(section,sent.report.characterBudget);
      if (sent.report.characterSelection) characterReport(section,sent.report.characterSelection,'sent-character');
      if(sent.report.recordSelection)recordReport(section,sent.report.recordSelection,'sent-records');
      section.append(preview('last-sent-json','Read exact serialized request body',()=>JSON.stringify(sent.requestBody,null,2)));
      body.append(section);
    }
    if(live.settings.narrationMode==='director'){
      const dg=group('director-preview','Director · next request preview'),d=previewResult.director;
      if(d)dg.append(node('p',`${d.usedTokens.toLocaleString()} estimated Director input tokens. Narrator selection is provisional until a contract exists.`,'muted'),preview('director-next-json','Read Director input',JSON.stringify({messages:d.apiMessages,response_format:d.responseFormat},null,2)));
      else dg.append(node('p',previewResult.directorError ?? 'Director preview unavailable.','muted'));
      body.append(dg);
    }
    const scene = group('scene', 'Current scene & memory');
    scene.append(node('p', r.scene ? r.scene.raw+' (from turn '+r.scene.fromTurn+')' : 'No current scene included.', 'muted'));
    for (const [key,label] of [['memory','Read assembled memory block'],['replyContract','Read reply contract'],['reminder','Read scene reminder']]) {
      if (sections[key]) scene.append(preview(key+'-text', label, sections[key]));
    }
    if (sections.memory) scene.append(node('p', 'This block includes the character and location text shown under Lorebooks.', 'muted'));
    body.append(scene);
    const messages = built.inspection.messages;
    const conversation = group('conversation', `Conversation · ${messages.length} messages`, false, d => {
      const opening = messages.filter(m => m.source==='Opening exchange');
      const recent = messages.filter(m => m.source!=='Opening exchange');
      if (opening.length) {
        d.append(node('h4', 'Opening exchange'));
        messageList(d, 'opening', opening);
      }
      d.append(node('h4', 'Retained conversation'));
      if (recent.length) messageList(d, 'recent', recent);
      else d.append(node('p', 'No later messages included.', 'muted'));
      if (sections.gap) d.append(preview('gap-text', 'Read omitted turns marker', sections.gap));
      const window = r.blocks.find(b => b.key==='window');
      if (window?.fromTurn) d.append(node('p', `turns ${window.fromTurn}–${window.toTurn} · ${window.messages} messages · ${window.mode==='block' ? 'moves in steps of '+window.step : window.mode}`, 'muted'));
    });
    body.append(conversation);
    const updates = group('updates', 'Memory updates');
    const pending = computeTurns(live.messages).assistants.filter(a => a.order>(live.session.memoryState?.extractedThroughOrder ?? 0)).length;
    updates.append(node('p', `${pending} pending memory turns · batch ${mem.batchTurns} · lag ${mem.lagTurns}`, 'muted'));
    updates.append(node('p', live.session.memoryState?.lastUpdateTurns ? 'Updated through turns '+live.session.memoryState.lastUpdateTurns : 'Not started yet', 'muted'));
    if (live.session.memory?.autoUpdate) {
      const update = button(live.session.memoryState?.paused ? 'Retry' : 'Update now', async b => {
        b.disabled = true;
        try { await updateNow(live.session.id, {retry:live.session.memoryState?.paused}); }
        finally { if (state.sessionId===live.session.id) void render(); }
      });
      update.disabled = !!state.busy || isRunning(live.session.id);
      update.title = state.busy ? 'Wait for the current reply or summary.' : isRunning(live.session.id) ? 'A memory update is already running.' : '';
      updates.append(update);
    } else updates.append(node('p', 'Automatic memory updates are off.', 'muted'));
    if (live.session.memoryState?.lastError) updates.append(node('p', 'Last memory update failed: '+live.session.memoryState.lastError, 'memory-warning'));
    const raw = lastRawAnswer(live.session.id);
    if (raw && live.session.memoryState?.lastError) updates.append(preview('raw-answer', 'Show last raw answer', raw));
    body.append(updates);
    if (r.mode==='legacy' && !anyMemory(mem)) overview.append(node('p', 'Memory is off for this story.', 'muted'), button('Set up memory', () => {
      closeViewer(); document.dispatchEvent(new CustomEvent('memory-settings'));
    }));
    const full = group('full-request', `Full request · ${built.apiMessages.length} messages`, false, d => {
      messageList(d, 'request', built.apiMessages.map((m,requestIndex) => ({...m,requestIndex})));
    });
    full.append(button('Copy request as text', async () => {
      await copy(built.apiMessages.map(m => '=== '+m.role.toUpperCase()+' ===\n'+m.content).join('\n\n'));
      toast('Request copied');
    }));
    body.append(full);
    dialog.querySelector('.memory-content')?.remove(); dialog.append(body);
    body.scrollTop = scrollPositions.get('body') ?? 0;
    for (const e of body.querySelectorAll('.context-scroll')) e.scrollTop = scrollPositions.get(e.dataset.scrollKey) ?? 0;
    if (focusKey) [...body.querySelectorAll('summary,pre,button')].find(e => e.dataset.focusKey===focusKey)?.focus({preventScroll:true});
  } catch (e) {
    if(run!==version || !open || live && state.sessionId!==live.session.id)return;
    renderCached();
    dialog.querySelector('.memory-content')?.append(node('p',e.message,'memory-warning'));
  }
}
function closeViewer() { document.querySelector('#context-viewer .settings-close')?.click(); }

function recordReport(parent,books,prefix) {
  const root=group(prefix,'Selected lorebook records');
  for(const [book,report] of Object.entries(books)) {
    const section=group(prefix+'-'+book,book+' · '+report.budget+' tokens');
    for(const entry of report.entries){
      const card=group(prefix+'-'+entry.entryId,entry.name);
      card.append(preview(prefix+'-'+entry.entryId+'-text','Exact selected text',entry.text));
      for(const r of entry.records){const detail=group(prefix+'-'+entry.entryId+'-'+r.id,(r.selected?'Selected':'Omitted')+' · '+r.category+' · '+r.reason);detail.append(node('p','Current matches: '+(r.currentMatches.join(', ')||'none')+' · recent matches: '+(r.recentMatches.join(', ')||'none')+' · related subjects: '+((r.linkedSubjects ?? []).map(s=>s.name).join(', ')||r.linked.join(', ')||'none'),'muted'));for(const [i,s] of r.sources.entries())detail.append(preview(prefix+'-'+entry.entryId+'-'+r.id+'-'+i,s.section+' · offsets '+s.start+'–'+s.end,s.text));card.append(detail);}section.append(card);
    }root.append(section);
  }parent.append(root);
}

function characterReport(parent, report, prefix, live = null) {
  const section=group(prefix,'Character coverage · '+(report.fullFit ? 'full cards fit' : 'fair allocation')+' · '+report.budget+' tokens');
  for(const c of report.characters) {
    const card=group(prefix+'-'+c.entryId,c.name+' · '+(c.identity ? 'identity included' : 'identity omitted'));
    card.append(node('p', 'Core coverage: '+Object.entries(c.coreCoverage).map(([k,v])=>k+' '+(v ? 'included' : 'missing')).join(' · '),'muted'));
    for(const b of c.invalidCores)card.append(node('p',b.reason,'memory-warning'));
    if(live)card.append(button('Review core sources',()=>reviewCharacterCore(live,c.entryId),'btn small'));
    card.append(preview(prefix+'-'+c.entryId+'-rendered','Read exact selected character text',c.text));
    for(const u of c.units) {
      const detail=group(prefix+'-'+c.entryId+'-'+u.id,(u.selected ? 'Selected' : 'Omitted or partly covered')+' · '+u.reason);
      detail.append(node('p', 'Round '+u.round+' · current matches: '+(u.currentMatches.join(', ') || 'none')+' · recent matches: '+(u.recentMatches.join(', ') || 'none')+' · author preference: '+u.authorPreference+' · recency: '+u.recency,'muted'));
      for(const [i,s] of u.sources.entries())for(const [kind,parts] of [['Included',s.included],['Omitted',s.omitted]])for(const [j,p] of parts.entries())detail.append(preview(prefix+'-'+c.entryId+'-'+u.id+'-'+i+'-'+kind+'-'+j,kind+' · '+s.section+' · source offsets '+p.start+'–'+p.end,p.text));
      card.append(detail);
    }
    section.append(card);
  }
  parent.append(section);
}
function reviewCharacterCore(live, entryId) {
  const base=live.entries.find(e=>e.id===entryId);if(!base)return;
  const staged=structuredClone(base),source={id:live.session.id,uid:currentUid()},dialog=subSheet('Review core · '+base.name),body=node('div',null,'memory-content');
  dialog.dialog.append(body);renderCoreEditor(body,staged,()=>{}, {messages:live.messages,session:live.session}).open=true;
  body.append(button('Save reviewed references',async()=>{
    if(state.sessionId!==source.id || currentUid()!==source.uid)throw new Error('Story or account changed; reopen core review.');
    if(state.busy)throw new Error('Wait for the current reply or summary.');
    await saveEntry(source,staged,base);dialog.hide();toast('Core references saved');void render();
  },'btn primary'),button('Cancel',dialog.hide));
}

function characterBudgetReport(parent,report) {
  const section=node('div');section.append(node('p','Character budget · 80% priority / 20% supporting · unused space shared','muted'));
  for(const [key,label] of [['priority','Protagonist / Core / Major'],['supporting','Minor / Background']]){const group=report[key];section.append(node('p',`${label}: ${group.used.toLocaleString()} / ${group.allocation.toLocaleString()} initial tokens · ${group.included} of ${group.eligible} cards${group.borrowed ? ' · '+group.borrowed.toLocaleString()+' borrowed tokens' : ''}`,'muted'));}
  section.append(node('p',`${report.tokens.toLocaleString()} / ${report.budget.toLocaleString()} fitted character tokens including framing. Required constraints may borrow across groups.`,'muted'));
  for(const item of report.omitted ?? [])section.append(node('p',item.name+' · '+item.group+' · '+item.reason,'muted'));
  parent.append(section);
}
