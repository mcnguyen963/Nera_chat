import {effectiveActiveSettings} from '../story-settings-store.js';
import {computeTurns} from '../turns.js';
import { normalizeMemory, anyMemory } from '../memory-settings.js';
import { state } from '../state.js';
import { buildContextForRequest } from '../context-builder.js';
import { memorySnapshot, prepareMemorySnapshot } from './chat-view.js';
import { lastRawAnswer, updateNow, isRunning } from '../memory-updater.js';
import { node,button,sheet,copy,toast } from './memory-ui.js';
let open = false, version = 0, timer;
export function initContextViewer() {
  document.addEventListener('context-details',openContextViewer);
  document.getElementById('chat-input').addEventListener('input',() => { if (open) { clearTimeout(timer); timer = setTimeout(render,400); } });
  for (const event of ['lore-changed','memory-refresh','session-changed','settings-changed','story-settings-changed']) document.addEventListener(event,() => { if (open) void render(); });
}
export function openContextViewer() {
  if (open) return;
  open = true;
  sheet(document.getElementById('context-viewer'),'NEXT REQUEST',{ className:'context-sheet',close:() => { open = false; ++version; clearTimeout(timer); return true; } });
  void prepareMemorySnapshot().then(()=>render()).catch(e=>toast(e.message));
}
async function render() {
  const dialog = document.querySelector('#context-viewer .sheet'); if (!dialog) return;
  dialog.querySelector('.memory-content')?.remove(); const body = node('div',null,'memory-content'); dialog.append(body);
  const run = ++version;
  let live = memorySnapshot(); if (!live) { body.append(node('p','Open a story to see its context.','muted')); return; }
  try {
    body.append(button('Refresh',async()=>{await prepareMemorySnapshot();void render();}));
    const draftText = document.getElementById('chat-input').value;
    const built = await buildContextForRequest(live.session,effectiveActiveSettings(),{ messages:live.messages,loreEntries:live.entries,draftText });
    if (run !== version || !open || state.sessionId!==live.session.id) return;
    const r = built.report;
    body.append(node('p',`${r.totals.input.toLocaleString()} input / ${r.totals.max.toLocaleString()} tokens`));
    if (live.providerUsage) body.append(node('p',`Last sent request: provider counted ${live.providerUsage.promptTokens.toLocaleString()} input tokens (local estimate ${live.providerUsage.estimate.toLocaleString()}).`,'muted'));
    if (draftText.trim()) body.append(node('p','including your draft','muted'));
    const bar = node('div',null,'context-segments');
    for (const [i,b] of r.blocks.entries()) { const seg = node('span'); seg.style.width = (100*b.tokens/r.totals.max)+'%'; seg.style.background = `hsl(0 0% ${30+i*7}%)`; seg.title = b.label+': '+b.tokens; bar.append(seg); } body.append(bar);
    for (const b of r.blocks) { const row = node('div',null,'context-block-row'); row.append(node('span',b.label),node('span',b.tokens.toLocaleString()+(b.budget ? ' / '+b.budget.toLocaleString() : ''))); body.append(row); if (b.cut) body.append(node('p',b.cut+' older notes not sent','muted')); if (b.key === 'window' && b.fromTurn) body.append(node('p',`turns ${b.fromTurn}–${b.toTurn} · ${b.messages} messages · ${b.mode === 'block' ? 'moves in steps of '+b.step : b.mode}`,'muted')); }
    body.append(node('p','Separate max reply: '+r.totals.reserved.toLocaleString(),'muted'));
    if (r.loaded.length || r.skipped.length) body.append(node('h3','LOADED NOTES','eyebrow'));
    for (const e of [...r.loaded,...r.skipped]) {
      const row = node('div',null,'context-block-row');
      row.append(button(e.name,() => { closeViewer(); document.dispatchEvent(new CustomEvent('lorebooks',{ detail:{ entryId:e.entryId,book:e.book,newName:e.entryId ? null : e.name } })); },'lore-link'),node('span',e.tokens != null ? `${e.reason} · ${e.tokens}${e.linesCut ? ' · '+e.linesCut+' older lines not sent' : ''}${e.draft ? ' · draft' : ''}` : e.reason === 'no card' ? 'in scene, no card' : 'not loaded — '+e.reason));
      if (e.reason.startsWith('card limit')) row.append(button('Raise limit',() => { closeViewer(); document.dispatchEvent(new CustomEvent('memory-settings',{ detail:{ focus:'mem-'+e.book+'-maxCards' } })); },'btn small'));
      body.append(row);
    }
    body.append(node('h3','COVERAGE','eyebrow'));
    for(const [book,config] of Object.entries(normalizeMemory(live.session.memory).books)){
      const cards=live.entries.filter(e=>e.book===book),total=cards.reduce((n,e)=>n+Object.values(e.sections).reduce((n,s)=>n+(s.lines?.length ?? 0),0),0),sent=r.loaded.filter(e=>e.book===book).reduce((n,e)=>n+(e.linesSent ?? 0),0);
      const reasons=new Set(r.skipped.filter(e=>e.book===book).map(e=>e.reason));
      if(r.loaded.some(e=>e.book===book && e.linesCut))reasons.add('book token budget');
      if(!config.on)reasons.add('book disabled');
      if(total>sent && !reasons.size)reasons.add('not selected for this scene or memory disabled');
      body.append(node('p',`${book}: ${sent} notes sent · ${total-sent} omitted${reasons.size ? ' · '+[...reasons].join('; ') : ''}`,'muted'));
    }
    const mem=normalizeMemory(live.session.memory),pending=computeTurns(live.messages).assistants.filter(a=>a.order>(live.session.memoryState?.extractedThroughOrder ?? 0)).length;
    body.append(node('p',`${pending} pending memory turns · batch ${mem.batchTurns} · lag ${mem.lagTurns}`,'muted'));
    if (r.scene) body.append(node('h3','SCENE','eyebrow'),node('p',r.scene.raw+' (from turn '+r.scene.fromTurn+')','muted'));
    if (live.session.memory?.autoUpdate) { const update = button(live.session.memoryState?.paused ? 'Retry' : 'Update now',async b=>{b.disabled=true;try{await updateNow(live.session.id,{retry:live.session.memoryState?.paused});}catch(e){toast(e.message);}finally{b.disabled=false;void render();}}); update.disabled = !!state.busy || isRunning(live.session.id); update.title = state.busy ? 'Wait for the current reply or summary.' : isRunning(live.session.id) ? 'A memory update is already running.' : ''; body.append(node('h3','MEMORY UPDATES','eyebrow'),node('p',live.session.memoryState?.lastUpdateTurns ? 'Updated through turns '+live.session.memoryState.lastUpdateTurns : 'Not started yet','muted'),update); }
    if (live.session.memoryState?.lastError && !live.session.memoryState.paused) body.append(node('p','Last memory update failed: '+live.session.memoryState.lastError,'memory-warning'));
    for (const warning of r.warnings) body.append(node('p',warning,'memory-warning'));
    if (r.mode === 'legacy' && !anyMemory(normalizeMemory(live.session.memory))) body.append(node('p','Memory is off for this story.','muted'),button('Set up memory',() => { closeViewer(); document.dispatchEvent(new CustomEvent('memory-settings')); }));
    const raw = lastRawAnswer(live.session.id); if (raw && live.session.memoryState?.lastError) { const d = node('details'); d.append(node('summary','Show last raw answer'),node('pre',raw)); body.append(d); }
    body.append(button('Copy request as text',async () => { await copy(built.apiMessages.map(m => '=== '+m.role.toUpperCase()+' ===\n'+m.content).join('\n\n')); toast('Request copied'); }));
  } catch (e) { if (run === version) body.append(node('p',e.message,'memory-warning')); }
}
function closeViewer() { document.querySelector('#context-viewer .settings-close')?.click(); }
