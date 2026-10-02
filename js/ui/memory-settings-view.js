import { normalizeMemory, memoryValidationRanges } from '../memory-settings.js';
import { computeTurns, dueRange } from '../turns.js';
import { state } from '../state.js';
import { memorySnapshot, prepareMemorySnapshot } from './chat-view.js';
import { isRunning, updateNow, catchUp, stop } from '../memory-updater.js';
import { node, button, subSheet, toast } from './memory-ui.js';
const get = key => document.getElementById('mem-'+key);
const booleans = ['scene','lorebooks','autoUpdate','memoryBlock','blockWindow'];
const numbers = ['batchTurns','lagTurns','updateMaxTokens','reorganizeMaxTokens','blockDepth'];
let filled = null;
export function fillMemory(raw) {
  filled = normalizeMemory(raw);
  for (const key of booleans) get(key).checked = filled[key];
  for (const key of ['protagonist','blockRole',...numbers]) get(key).value = filled[key];
  for (const [book,b] of Object.entries(filled.books)) { get(book+'-on').checked = b.on; get(book+'-budget').value = b.budget; if (b.maxCards) get(book+'-maxCards').value = b.maxCards; }
  get('showScene').checked = localStorage.getItem('nera.memory.showScene') !== '0'; updateMemorySettingsHints();
}
export function readMemory(validate = false, integerField) {
  if (!filled) return normalizeMemory();
  const out = normalizeMemory();
  for (const key of booleans) out[key] = get(key).checked;
  for (const key of ['protagonist','blockRole']) out[key] = get(key).value;
  for (const key of numbers) out[key] = validate ? integerField(get(key).value,'mem-'+key) : get(key).value;
  for (const book of Object.keys(out.books)) { out.books[book].on = get(book+'-on').checked; for (const key of ['budget',...(book === 'characters' || book === 'locations' ? ['maxCards'] : [])]) out.books[book][key] = validate ? integerField(get(book+'-'+key).value,'mem-'+book+'-'+key) : get(book+'-'+key).value; }
  return normalizeMemory(out);
}
export function memoryDirty(original) {
  if (!filled) return false;
  const saved = normalizeMemory(original);
  if (booleans.some(k => get(k).checked !== saved[k])) return true;
  if (['protagonist','blockRole',...numbers].some(k => String(get(k).value) !== String(saved[k]))) return true;
  return Object.keys(saved.books).some(book => get(book+'-on').checked !== saved.books[book].on || ['budget',...(book === 'characters' || book === 'locations' ? ['maxCards'] : [])].some(k => String(get(book+'-'+k).value) !== String(saved.books[book][k])));
}
export function initMemorySettings(openLore) {
  for (const key of [...booleans,...numbers,'protagonist','blockRole',...['characters','locations','facts','events'].flatMap(b => [b+'-on',b+'-budget',...(b === 'characters' || b === 'locations' ? [b+'-maxCards'] : [])])]) get(key)?.addEventListener('input',updateMemorySettingsHints);
  get('showScene').addEventListener('change',() => { localStorage.setItem('nera.memory.showScene',get('showScene').checked ? '1' : '0'); document.dispatchEvent(new CustomEvent('scene-preference')); });
  get('open-lore').addEventListener('click',openLore);
  get('update-now').addEventListener('click',() => void manualUpdate());
  get('retry').addEventListener('click',() => void manualUpdate(true));
  get('catch-up').addEventListener('click',() => void catchUpDialog());
  document.addEventListener('memory-refresh',updateMemorySettingsHints);
}
async function manualUpdate(retry = false) { try { await prepareMemorySnapshot(); await updateNow(state.sessionId,{ retry }); } catch (e) { toast(e.message); } }
export function updateMemorySettingsHints() {
  const mem = readMemory(), available = (state.settings?.maxContextTokens ?? 120000)-(state.settings?.maxResponseTokens ?? 8192);
  const budget = mem.lorebooks ? Object.values(mem.books).filter(b => b.on).reduce((n,b) => n+b.budget,0) : 0;
  get('budget-summary').textContent = `Up to ${budget.toLocaleString()} of ${available.toLocaleString()} available tokens. Recent conversation has priority; lore uses the remaining space.`+(budget>available*.5 ? ' Leaves little room for recent messages.' : ''); get('budget-summary').style.color = budget>available*.5 ? 'var(--danger)' : '';
  get('show-scene-row').classList.toggle('hidden',!mem.scene);
  for (const book of Object.keys(mem.books)) { get(book+'-on').disabled = !mem.lorebooks && !mem.autoUpdate; get(book+'-budget').disabled = !mem.lorebooks; if (get(book+'-maxCards')) get(book+'-maxCards').disabled = !mem.lorebooks; }
  const hints = [];
  if (mem.lorebooks && !mem.scene) hints.push('Turn on Scene line so characters who are present (not just mentioned) are remembered.');
  if (mem.autoUpdate && !mem.scene) hints.push('Notes will be stamped with turn numbers only — turn on Scene line to add in-story dates.');
  if (mem.memoryBlock && !mem.scene && !mem.lorebooks) hints.push('The memory block will only contain a reminder of the fixed system plan.');
  if (mem.autoUpdate && state.settings?.autoSummarizationEnabled) hints.push('Tip: with Events & threads and automatic updates on, you can usually turn off auto-summary (Context & summaries).');
  const live = memorySnapshot(), turns = computeTurns(live?.messages ?? []), pointer = live?.session.memoryState?.extractedThroughOrder;
  const done = turns.assistants.filter(a => a.order <= (pointer ?? 0)).at(-1)?.turn ?? 0, pending = Math.max(0,turns.lastTurn-mem.lagTurns-done);
  const recent = turns.assistants.slice(-20), totalTokens = (live?.messages ?? []).filter(m => recent.some(a => turns.turnById.get(m.id) === a.turn)).reduce((n,m) => n+(m.tokenCount ?? 0),0);
  if (mem.autoUpdate && totalTokens && recent.length) { const windowTurns = Math.floor(Math.max(0,available-budget-(live?.report?.blocks.filter(b => ['system','summary','anchor'].includes(b.key)).reduce((n,b) => n+b.tokens,0) ?? 0))/(totalTokens/recent.length)); if (windowTurns < mem.batchTurns+mem.lagTurns+1) hints.push(`Your recent-message window holds about ${windowTurns} turns, but up to ${mem.batchTurns+mem.lagTurns} turns can be waiting for a memory update. Those turns could drop out of context. Lower the book budgets or the batch size.`); }
  get('hints').textContent = hints.join('\n\n');
  const savedOn = live?.session.memory?.autoUpdate === true, paused = live?.session.memoryState?.paused;
  get('update-actions').classList.toggle('hidden',!savedOn);
  for (const key of ['update-now','catch-up','retry']) { get(key).disabled = !!state.busy || isRunning(state.sessionId); get(key).title = state.busy ? 'Wait for the current reply or summary.' : isRunning(state.sessionId) ? 'A memory update is already running.' : ''; }
  get('retry').classList.toggle('hidden',!paused);
  get('update-status').textContent = paused ? 'Paused. '+live.session.memoryState.lastError : pointer == null ? `Not started yet — the first update runs after turn ${mem.batchTurns+mem.lagTurns}.` : done ? `Updated through turn ${done} · next update after turn ${done+mem.batchTurns+mem.lagTurns}.` : `Waiting for ${Math.max(0,mem.batchTurns-pending)} more turns.`;
}
export async function chooseMemoryStart(mem,previous,session) {
  if (!mem.autoUpdate || previous.autoUpdate) return null;
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
  try {
    const live = await prepareMemorySnapshot(), mem = normalizeMemory(live.session.memory), turns = computeTurns(live.messages);
    const eligible = turns.assistants.slice(0,Math.max(0,turns.assistants.length-mem.lagTurns)).filter(a => a.order > (live.session.memoryState?.extractedThroughOrder ?? Infinity));
    const calls = Math.ceil(eligible.length/mem.batchTurns), tokens = live.messages.filter(m => m.order>(live.session.memoryState?.extractedThroughOrder ?? Infinity)).reduce((n,m) => n+(m.tokenCount ?? 0),0);
    const controller = new AbortController();
    const s = subSheet('Catch up…',{ close:() => { controller.abort(); stop(live.session.id); return true; } });
    const body = node('div',null,'memory-content'), progress = node('p',`Catch up on ${eligible.length} turns? This makes about ${calls} model calls (about ${tokens.toLocaleString()} input tokens). You can stop at any time.`);
    body.append(progress,button('Catch up',async b => { b.disabled = true; await catchUp(live.session.id,{ signal:controller.signal,onProgress:({ range,index }) => { progress.textContent = `Updating turns ${range.fromTurn}–${range.toTurn} (${index} of ${calls})…`; } }); progress.textContent = 'Finished. Saved updates are kept.'; }),button('Stop',s.hide)); s.dialog.append(body);
  } catch (e) { toast(e.message); }
}
