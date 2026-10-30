import { normalizeCalendar, parseStoryDate, parseClock, formatStoryDate, clockText, calendarInstruction } from '../story-calendar.js';
import {rebuildLabel} from '../memory-rebuild.js';
import { skippedNotesText } from '../memory-skipped.js';
import {getPref,setPref} from '../local-pref.js';
import {requestInputLimit} from '../request-budget.js';
import {effectivelyPaused,usableLore} from '../continuity.js';
import {currentUid} from '../auth.js';
import {loreSemantic,semanticConnection} from '../lore-semantic.js';
import {updateSession} from '../sessions.js';
import { normalizeMemory, memoryValidationRanges } from '../memory-settings.js';
import { parseScene, sceneLine } from '../scene.js';
import { computeTurns, dueRange, dueRangeStatus } from '../turns.js';
import { state } from '../state.js';
import { memorySnapshot, prepareMemorySnapshot, dismissMemoryRebuild } from './chat-view.js';
import { isRunning, updateNow, catchUp, stop, rebuildFrom } from '../memory-updater.js';
import { copyText } from './clipboard.js';
import { node, button, subSheet, toast } from './memory-ui.js';
const get = key => document.getElementById('mem-'+key);
const booleans = ['characterSelection','scene','sceneFallback','lorebooks','autoUpdate','memoryBlock','blockWindow','semanticLore','historyRecall','semanticRecall','vectorCloudSync'];
const strings = ['protagonist','blockRole','sceneFallbackModel','replyContract','updateProfileId','semanticEndpoint','semanticModel'];
const seedKeys = ['date','time','place','present'];
const numbers = ['loreNotesPerSection','loreLookbackMessages','batchTurns','lagTurns','updateMaxTokens','reorganizeMaxTokens','blockDepth','historyRecallBudget','historyRecallPassages'];
let filled = null, rebuildNotice = null, historyIndexController = null, loreIndexController = null;
export function fillMemory(raw) {
  filled = normalizeMemory(raw);
  if(get('semantic-status'))get('semantic-status').textContent='';
  for (const key of booleans) get(key).checked = filled[key];
  for (const key of [...strings,...numbers]) get(key).value = filled[key];
  if(get('calendar-mode'))get('calendar-mode').value=filled.calendar.mode;
  if(get('calendar-anchor'))get('calendar-anchor').value=filled.calendar.anchor ?? '';
  refreshMemoryProfiles(filled.updateProfileId);
  const seed = parseScene(filled.startingScene);
  for (const key of seedKeys) get('starting-'+key).value = key === 'present' ? seed.present.join(', ') : key === 'date' ? seed.when ?? '' : seed[key] ?? (key === 'time' ? 'unknown' : '');
  for (const [book,b] of Object.entries(filled.books)) { get(book+'-on').checked = b.on; get(book+'-budget').value = b.budget; if (b.maxCards) get(book+'-maxCards').value = b.maxCards; }
  get('showScene').checked = getPref('nera.memory.showScene') !== '0'; updateMemorySettingsHints();
}
export function readMemory(validate = false, integerField) {
  if (!filled) return normalizeMemory();
  const out = normalizeMemory();
  for (const key of booleans) out[key] = get(key).checked;
  for (const key of strings) out[key] = get(key).value;
  if(validate && out.semanticLore)semanticConnection(out);
  out.calendar=normalizeCalendar({mode:get('calendar-mode')?.value,anchor:get('calendar-anchor')?.value});
  if(validate && out.calendar.mode==='modern'&&!out.calendar.anchor)throw new Error('Enter a weekday/date anchor, such as Friday 21/10/738.');
  const seed = Object.fromEntries(seedKeys.map(key => [key,get('starting-'+key).value.trim()]));
  if (seed.date || seed.place || seed.present || seed.time && seed.time !== 'unknown') {
    if (validate && (!seed.place || !seed.present)) throw new Error('A starting scene needs a location and attendees.');
    if(out.calendar.mode==='modern' && validate) {
      if(seed.date && seed.date!=='unknown') {const date=parseStoryDate(seed.date);if(!date?.valid)throw new Error('Enter a valid modern starting date.');const formatted=formatStoryDate(date,out.calendar);if(date.weekday!==null&&parseStoryDate(formatted).weekday!==date.weekday)throw new Error('Starting weekday conflicts with the calendar anchor.');seed.date=formatted;}
      if(seed.time && seed.time!=='unknown') {const clock=parseClock(seed.time);if(clock===null)throw new Error('Enter a valid starting clock, such as 15:40.');seed.time=clockText(clock);}
    }
    try { out.startingScene = sceneLine({ ...seed,present:seed.present.split(',').map(n => n.trim()).filter(Boolean) }); }
    catch (error) { if (validate) throw error; }
  }
  if (!out.startingScene && filled.startingSceneRaw) out.startingSceneRaw=filled.startingSceneRaw;
  for (const key of numbers) out[key] = validate ? integerField(get(key).value,'mem-'+key) : get(key).value;
  for (const book of Object.keys(out.books)) { out.books[book].on = get(book+'-on').checked; for (const key of ['budget',...(book === 'characters' || book === 'locations' ? ['maxCards'] : [])]) out.books[book][key] = validate ? integerField(get(book+'-'+key).value,'mem-'+book+'-'+key) : get(book+'-'+key).value; }
  return normalizeMemory(out);
}
export function memoryDirty(original) {
  if (!filled) return false;
  const saved = normalizeMemory(original);
  if(JSON.stringify(normalizeCalendar({mode:get('calendar-mode')?.value,anchor:get('calendar-anchor')?.value}))!==JSON.stringify(saved.calendar))return true;
  if (booleans.some(k => get(k).checked !== saved[k])) return true;
  if ([...strings,...numbers].some(k => String(get(k).value) !== String(saved[k]))) return true;
  const seed = parseScene(saved.startingScene);
  if (seedKeys.some(key => get('starting-'+key).value !== (key === 'present' ? seed.present.join(', ') : key === 'date' ? seed.when ?? '' : seed[key] ?? (key === 'time' ? 'unknown' : '')))) return true;
  return Object.keys(saved.books).some(book => get(book+'-on').checked !== saved.books[book].on || ['budget',...(book === 'characters' || book === 'locations' ? ['maxCards'] : [])].some(k => String(get(book+'-'+k).value) !== String(saved.books[book][k])));
}
export function initMemorySettings(openLore) {
  const userRole=get('blockRole')?.querySelector('option[value="user"]');
  if(userRole) userRole.textContent='User (recommended): notes travel with your latest message';
  for (const key of [...booleans,...numbers,...strings,'calendar-mode','calendar-anchor',...seedKeys.map(k => 'starting-'+k),...Object.keys(normalizeMemory().books).flatMap(b => [b+'-on',b+'-budget',...(b === 'characters' || b === 'locations' ? [b+'-maxCards'] : [])])]) get(key)?.addEventListener('input',updateMemorySettingsHints);
  get('calendar-copy')?.addEventListener('click',async()=>{try{const text=calendarInstruction(readMemory().calendar);if(!text)throw new Error('Choose modern time and enter an anchor first.');await copyText(text);toast('Copied. Review these instructions before adding them to your story prompt.');}catch(e){toast(e);}});
  get('showScene').addEventListener('change',() => { setPref('nera.memory.showScene',get('showScene').checked ? '1' : '0'); document.dispatchEvent(new CustomEvent('scene-preference')); });
  get('open-lore').addEventListener('click',openLore);
  for(const [key,force] of [['semantic-index',false],['semantic-rebuild',true]])get(key)?.addEventListener('click',async()=>{
    const button=get(key),status=get('semantic-status');
    if(state.busy || loreIndexController){toast('Finish the current operation first');return;}
    button.disabled=true;loreIndexController=new AbortController();get('semantic-cancel').hidden=false;
    try{
      const live=await prepareMemorySnapshot(),owner=currentUid(),sid=live.session.id,epoch=live.storyEpoch;
      if(!live.historyComplete)throw new Error('Full story history is not available. Open the story and try again.');
      const mem=readMemory();
      const captured=structuredClone({session:live.session,messages:live.messages,entries:live.entries});
      const check=()=>{const now=memorySnapshot();if(currentUid()!==owner || !now || now.session.id!==sid || now.storyEpoch!==epoch || now.session.historyRevision!==captured.session.historyRevision || now.session.loreRevision!==captured.session.loreRevision)throw new Error('Story or lore changed; build the index again.');};
      const entries=usableLore(captured.entries,captured.messages,captured.session).entries;
      status.textContent='Building the device index…';
      const result=await loreSemantic.index({owner,sid,mem,entries,check,force,signal:loreIndexController.signal,progress:({done,total})=>{status.textContent=`Indexed ${done} of ${total} records…`;}});
      status.textContent=`Indexed ${result.count} cards on this device. Save story settings to enable semantic search.`;
      if(live.session.memory?.vectorCloudSync && live.session.memory.semanticModel===mem.semanticModel && live.session.memory.semanticEndpoint===mem.semanticEndpoint){
        try{const {uploadStoryVectors}=await import('../vector-cloud-sync.js');await uploadStoryVectors(live,'lore',{getLive:()=>memorySnapshot()});status.textContent+= ' Lore vectors synced to cloud.';}
        catch(error){status.textContent+=' Cloud sync pending: '+error.message;}
      }
    }catch(error){status.textContent='Indexing failed: '+error.message;}
    finally{button.disabled=false;loreIndexController=null;get('semantic-cancel').hidden=true;}
  });
  get('semantic-cancel')?.addEventListener('click',()=>loreIndexController?.abort());
  for(const [key,force] of [['history-index',false],['history-rebuild',true]])get(key)?.addEventListener('click',async()=>{
    const button=get(key),status=get('history-status');
    if(state.busy || historyIndexController){toast('Finish the current operation first');return;}
    button.disabled=true;historyIndexController=new AbortController();get('history-cancel').hidden=false;
    try {
      const live=await prepareMemorySnapshot({history:true}),owner=currentUid(),sid=live.session.id,epoch=live.storyEpoch;
      const {indexOlderHistory}=await import('../history-recall.js');
      status.textContent='Indexing older messages on this device…';
      const result=await indexOlderHistory(live,{getLive:()=>memorySnapshot(),force,signal:historyIndexController.signal,onProgress:p=>{status.textContent=`Indexed ${p.messages} messages; embedded ${p.embedded} of ${p.total ?? p.passages} passages.`;}});
      if(currentUid()!==owner || state.sessionId!==sid || memorySnapshot()?.storyEpoch!==epoch)return;
      status.textContent=result.persisted ? `Indexed ${result.indexedMessages} messages and ${result.rows.length} passages on this device.` : 'Indexing finished in memory, but device storage is unavailable; it will not survive reload.';
      if(result.persisted && live.session.memory?.vectorCloudSync){
        try{const {uploadStoryVectors}=await import('../vector-cloud-sync.js');await uploadStoryVectors(live,'history',{getLive:()=>memorySnapshot()});status.textContent+=' Message vectors synced to cloud.';}
        catch(error){status.textContent+=' Cloud sync pending: '+error.message;}
      }
    } catch(error) {status.textContent='Indexing failed: '+error.message;}
    finally {button.disabled=false;historyIndexController=null;get('history-cancel').hidden=true;}
  });
  get('history-cancel')?.addEventListener('click',()=>historyIndexController?.abort());
  for(const [key,direction] of [['vector-upload','upload'],['vector-repair','repair'],['vector-download','download']]) get(key)?.addEventListener('click',async()=>{
    const control=get(key),status=get('vector-status');if(state.busy){toast('Finish the current turn first');return;}control.disabled=true;
    try {
      const live=await prepareMemorySnapshot({history:true}),{uploadStoryVectors,downloadStoryVectors}=await import('../vector-cloud-sync.js');
      const operation=direction==='download' ? downloadStoryVectors : uploadStoryVectors,results=[];
      for(const kind of ['history','lore']){
        status.textContent=`${direction==='download'?'Downloading':'Uploading'} ${kind} vectors…`;
        try{const result=await operation(live,kind,{getLive:()=>memorySnapshot(),force:direction==='repair'});results.push(direction==='download' ? `${kind}: ${result.restored} restored, ${result.skipped} outdated${result.modelIds?.length ? '; models: '+result.modelIds.join(', ') : ''}` : result.unchanged ? `${kind}: no local changes; cloud was not checked` : `${kind}: ${result.manifest.count} vectors synced`);}catch(error){results.push(`${kind}: ${error.message}`);}
      }
      status.textContent=results.join(' · ');
    }catch(error){status.textContent='Vector sync failed: '+error.message;}
    finally{control.disabled=false;}
  });
  get('update-now').addEventListener('click',() => void manualUpdate());
  get('reextract')?.addEventListener('click',async()=>{try{const live=memorySnapshot(),order=live?.session.memoryState?.rebuildFromOrder;if(order==null)return;if(!confirm('Re-extract edited history from this turn? Generated notes will be marked for review and backed up.'))return;const finished=await rebuildFrom(live.session.id,order);toast(finished ? 'Re-extraction finished; review prior notes in Lorebooks.' : 'Re-extraction stopped. '+(memorySnapshot(live.session.id)?.session.memoryState?.lastError ?? 'Saved updates are kept.'));}catch(e){toast(e.message);}});
  get('dismiss-rebuild')?.addEventListener('click',async()=>{try{if(state.busy){toast('Finish the current turn first');return;}if(!rebuildNotice)return;await dismissMemoryRebuild(rebuildNotice.sessionId,rebuildNotice.seenRevision);}catch(e){toast(e.message);}});
  get('choose-start')?.addEventListener('click',async()=>{try{if(state.busy){toast('Finish the current turn first');return;}const live=await prepareMemorySnapshot(),mem=normalizeMemory(live.session.memory),pointer=await chooseMemoryStart(mem,mem,live.session,true);if(pointer==='cancel' || pointer==null)return;await updateSession(live.session.id,{'memoryState.extractedThroughOrder':pointer});document.dispatchEvent(new CustomEvent('memory-refresh'));}catch(e){toast(e.message);}});
  get('retry').addEventListener('click',() => void manualUpdate(true));
  get('catch-up').addEventListener('click',() => void catchUpDialog());
  document.addEventListener('memory-refresh',updateMemorySettingsHints);
  document.addEventListener('settings-changed',()=>refreshMemoryProfiles());
}
export function refreshMemoryProfiles(selected = get('updateProfileId')?.value ?? '') {
  const select=get('updateProfileId');if(!select)return;
  const profiles=state.settings?.profiles ?? [];
  const option=(value,label)=>{const item=document.createElement('option');item.value=value;item.textContent=label;return item;};
  const options=[option('','Use narrator profile'),...profiles.map(p=>option(p.id,p.name+(p.modelId ? ' — '+p.modelId : '')))];
  if(selected && !profiles.some(p=>p.id===selected)){const missing=option(selected,'Unavailable profile — choose another');missing.disabled=true;options.push(missing);}
  select.replaceChildren(...options);select.value=selected;
}
let preparingUpdate=false;
async function manualUpdate(retry=false){
  if(preparingUpdate || isRunning(state.sessionId) || state.busy)return;
  const sid=state.sessionId;preparingUpdate=true;updateMemorySettingsHints();get('update-status').textContent='Preparing memory…';
  try{await prepareMemorySnapshot();if(sid===state.sessionId)await updateNow(sid,{retry});}catch(e){toast(e.message);}
  finally{preparingUpdate=false;updateMemorySettingsHints();}
}
export function updateMemorySettingsHints() {
  const mem = readMemory(), available = Math.floor(.9*requestInputLimit(state.settings ?? {maxContextTokens:120000}));
  const budget = mem.lorebooks ? Object.values(mem.books).filter(b => b.on).reduce((n,b) => n+b.budget,0) : 0;
  get('budget-summary').textContent = `Up to ${budget.toLocaleString()} of ${available.toLocaleString()} available tokens. Recent conversation has priority; lore uses the remaining space.`+(budget>available*.5 ? ' Leaves little room for recent messages.' : ''); get('budget-summary').style.color = budget>available*.5 ? 'var(--danger)' : '';
  get('show-scene-row').classList.toggle('hidden',!mem.scene);
  get('scene-options').classList.toggle('hidden',!mem.scene);
  get('calendar-anchor-row')?.classList.toggle('hidden',mem.calendar.mode!=='modern');
  get('calendar-help')?.classList.toggle('hidden',mem.calendar.mode!=='modern');
  get('calendar-copy')?.classList.toggle('hidden',mem.calendar.mode!=='modern');
  for (const book of Object.keys(mem.books)) { get(book+'-on').disabled = !mem.lorebooks && !mem.autoUpdate; get(book+'-budget').disabled = !mem.lorebooks; if (get(book+'-maxCards')) get(book+'-maxCards').disabled = !mem.lorebooks; }
  get('loreLookbackMessages').disabled = !mem.lorebooks;
  const hints = [];
  if (mem.startingSceneRaw) hints.push('Could not read this starting scene: '+mem.startingSceneRaw+'. Enter its date, time, location and attendees above.');
  if (mem.lorebooks && !mem.scene) hints.push('Turn on Scene line so characters who are present (not just mentioned) are remembered.');
  if (mem.autoUpdate && !mem.scene) hints.push('Notes will be stamped with turn numbers only — turn on Scene line to add in-story dates.');
  if (mem.memoryBlock && !mem.scene && !mem.lorebooks) hints.push('The memory block will only contain a reminder of the fixed system plan.');
  if (mem.autoUpdate && state.settings?.autoSummarizationEnabled) hints.push('Tip: with Events & threads and automatic updates on, you can usually turn off auto-summary (Context & summaries).');
  const live = memorySnapshot(), turns = computeTurns(live?.messages ?? []), pointer = live?.session.memoryState?.extractedThroughOrder;
  const done = turns.assistants.filter(a => a.order <= (pointer ?? 0)).at(-1)?.turn ?? 0, pending = Math.max(0,turns.lastTurn-mem.lagTurns-done);
  const recent = turns.assistants.slice(-20), totalTokens = (live?.messages ?? []).filter(m => recent.some(a => turns.turnById.get(m.id) === a.turn)).reduce((n,m) => n+(m.tokenCount ?? 0),0);
  if (mem.autoUpdate && totalTokens && recent.length) { const windowTurns = Math.floor(Math.max(0,available-budget-(live?.report?.blocks.filter(b => ['system','summary','anchor'].includes(b.key)).reduce((n,b) => n+b.tokens,0) ?? 0))/(totalTokens/recent.length)); if (windowTurns < mem.batchTurns+mem.lagTurns+1) hints.push(`Your recent-message window holds about ${windowTurns} turns, but up to ${mem.batchTurns+mem.lagTurns} turns can be waiting for a memory update. Those turns could drop out of context. Lower the book budgets or the batch size.`); }
  get('hints').textContent = hints.join('\n\n');
  const savedOn = live?.session.memory?.autoUpdate === true, paused = effectivelyPaused(live?.session.memoryState);
  get('update-actions').classList.toggle('hidden',!savedOn);
  for (const key of ['update-now','catch-up','retry']) { get(key).disabled = !!state.busy || preparingUpdate || isRunning(state.sessionId); get(key).title = state.busy ? 'Wait for the current reply or summary.' : preparingUpdate || isRunning(state.sessionId) ? 'A memory update is already running.' : ''; }
  get('retry').classList.toggle('hidden',!paused);
  const rebuildOrder=live?.session.memoryState?.rebuildFromOrder;get('reextract')?.classList.toggle('hidden',!live?.session.memoryState?.needsRebuild);if(get('reextract') && rebuildOrder!=null)get('reextract').textContent=rebuildLabel(live);get('dismiss-rebuild')?.classList.toggle('hidden',!live?.session.memoryState?.needsRebuild);
  rebuildNotice=live?.session.memoryState?.needsRebuild ? {sessionId:live.session.id,seenRevision:live.session.historyRevision ?? 0} : null;
  get('choose-start')?.classList.toggle('hidden',pointer!=null);
  const status=dueRangeStatus(live?.messages ?? [],live?.session.memoryState,mem);
  get('update-status').textContent = paused ? ['Paused.',live.session.memoryState.lastError].filter(Boolean).join(' ') : pointer == null ? 'Memory start not set. Choose a start turn.' : status.reason==='pending' ? `Waiting for you to accept the reply at T${status.turn}.` : status.reason==='waiting' ? `${status.have} of ${status.need} turns ready (the last ${status.lag} turns wait).` : done ? `Updated through turn ${done} · next update after turn ${done+mem.batchTurns+mem.lagTurns}.` : `Waiting for ${Math.max(0,mem.batchTurns-pending)} more turns.`;
  if (!paused && live?.session.memoryState?.lastError) get('update-status').textContent += ' Last update failed: '+live.session.memoryState.lastError;
  const skipped=skippedNotesText(live?.session.memoryState?.lastSkipped);
  if(skipped) get('update-status').textContent+=' '+skipped;
}
export async function chooseMemoryStart(mem,previous,session,force=false) {
  if (!mem.autoUpdate || previous.autoUpdate && !force) return null;
  const live = await prepareMemorySnapshot(), turns = computeTurns(live.messages), pointer = session.memoryState?.extractedThroughOrder;
  const done = turns.assistants.filter(a => a.order <= (pointer ?? 0)).at(-1)?.turn ?? 0;
  if (pointer != null && turns.lastTurn-mem.lagTurns-done <= mem.batchTurns*3) return null;
  if (turns.lastTurn <= mem.lagTurns) return pointer == null ? 0 : null;
  return new Promise(resolve => {
    let settled = false;
    const s = subSheet('Where should memory updates start?',{ close:() => { if (!settled) resolve('cancel'); return true; } });
    const choose = value => { settled = true; resolve(value); s.hide(); };
    const body = node('div',null,'memory-content');
    if (pointer != null) body.append(button(`Continue where it stopped (turn ${done})`,() => choose(null),'btn primary'));
    const start = turns.assistants[Math.max(0,turns.assistants.length-mem.lagTurns)-1]?.order ?? 0;
    body.append(button('From now on — recommended if you imported lorebooks',() => choose(start),'btn primary'),button('From the beginning — memory catches up one batch per turn, or all at once with Catch up…',() => choose(0)),button('Cancel',() => choose('cancel'))); s.dialog.append(body);
  });
}
async function catchUpDialog() {
  const sid=state.sessionId,controller=new AbortController();let started=false;
  const s=subSheet('Catch up…',{close:()=>{controller.abort();if(started)stop(sid);return true;}});
  const body=node('div',null,'memory-content'),progress=node('p','Preparing memory…');body.append(progress);s.dialog.append(body);
  try {
    const live = await prepareMemorySnapshot(), mem = normalizeMemory(live.session.memory), turns = computeTurns(live.messages);
    if(controller.signal.aborted)return;
    if(state.sessionId!==sid){s.hide();return;}
    const eligible = turns.assistants.slice(0,Math.max(0,turns.assistants.length-mem.lagTurns)).filter(a => a.order > (live.session.memoryState?.extractedThroughOrder ?? 0));
    const calls = Math.ceil(eligible.length/mem.batchTurns), tokens = live.messages.filter(m => m.order>(live.session.memoryState?.extractedThroughOrder ?? 0)).reduce((n,m) => n+(m.tokenCount ?? 0),0);
    progress.textContent=`Catch up on ${eligible.length} turns? This makes about ${calls} model calls (about ${tokens.toLocaleString()} input tokens). You can stop at any time.`;
    body.append(button('Catch up',async b => {if(state.busy){toast('Finish the current turn first');return;}if(isRunning(live.session.id)){toast('Wait for the current memory update.');return;}started=true;b.disabled=true;try {const finished=await catchUp(live.session.id,{ signal:controller.signal,onProgress:({ range,index }) => { progress.textContent = `Updating turns ${range.fromTurn}–${range.toTurn} (${index} of ${calls})…`; } }); progress.textContent=finished ? 'Finished. Saved updates are kept.' : 'Stopped. Saved updates are kept. '+(memorySnapshot(live.session.id)?.session.memoryState?.lastError ?? 'No further turns were updated.');}catch(e){progress.textContent='Catch up failed: '+e.message;}finally{started=false;b.disabled=false;b.textContent='Catch up';} }),button('Stop',s.hide));
  } catch (e) {if(!controller.signal.aborted)progress.textContent='Could not prepare memory: '+e.message;}
}
