import { noteNeedsReview, snapshotNeedsReview, sectionMeta, cutoffLabel } from '../continuity.js';
import { rebuild, rebuildFrom } from '../memory-updater.js';
import { state } from '../state.js';
import { normalizeMemory } from '../memory-settings.js';
import { memorySnapshot, prepareMemorySnapshot } from './chat-view.js';
import * as store from '../lore-store.js';
import { makeEntry, newLoreId, normalizeName, STOPLIST, SECTION_KEYS } from '../lore-lines.js';
import { sortLines, renderEntry, sectionLabel } from '../lore-select.js';
import { BOOK_LABELS, detectFormat, fromMarkdown, fromJson, toMarkdown, toJson, planImport } from '../lore-format.js';
import { LOREBOOK_TEMPLATE_MD, LOREBOOK_TEMPLATE_JSON, fillProtagonist } from '../memory-prompts.js';
import { formatTurnsTranscript, computeTurns } from '../turns.js';
import { latestScene } from '../scene.js';
import { planReorganize, runReorganizeBatch } from '../memory-reorganize.js';
import { countTokens } from '../tokenizer.js';
import { node, button, field, sheet, subSheet, toast, copy, download } from './memory-ui.js';
let opened = false, sid = null, book = 'characters', screen = 'books', filter = 'all', selected = null, base = null, staged = null, editor = null, list = null, rail = null, view = null, search = '', threadFilter = 'open', newPrefill = null;
let focusRestore = null, editorVersion = 0;
const reorganizing = new Set(), sizes = new Map();
let pendingEntryId = null, navigationId = null, navigationDepth = 0, navigationKey = null, fromHistory = false;
const live = () => memorySnapshot(sid);
const entries = () => live()?.entries ?? [];
const normSearch = s => String(s).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const linesOf = e => Object.values(e.sections).flatMap(s => s.lines);
const dirty = () => staged && JSON.stringify(staged) !== JSON.stringify(base);
const canLeave = () => !dirty() || confirm('Discard changes?');
const seenKey = () => 'nera.lore.seen.'+sid;
function seen() { try { return JSON.parse(localStorage.getItem(seenKey()) ?? '{}'); } catch { return {}; } }
let lineMemo={src:null,value:null};
function lineContext() {
  const all=live()?.messages ?? [];
  if (lineMemo.src===all) return lineMemo.value;
  const turns=computeTurns(all),orders=new Set(),turnByOrder=new Map(),editedAtByTurn=new Map();
  for (const a of turns.assistants) { orders.add(a.order);turnByOrder.set(a.order,a.turn); }
  for (const m of all) {
    const t=turns.turnById.get(m.id),at=m.editedAt?.toMillis?.() ?? (m.editedAt?.seconds!=null ? m.editedAt.seconds*1000+(m.editedAt.nanoseconds ?? 0)/1e6 : m.editedAt ? new Date(m.editedAt).getTime() : 0);
    editedAtByTurn.set(t,Math.max(at,editedAtByTurn.get(t) ?? 0));
  }
  lineMemo={src:all,value:{orders,turnByOrder,editedAtByTurn}};return lineMemo.value;
}
function deletedOrders() {return lineContext().orders;}
function deletedLine(l) {return l.src!=null && !lineContext().orders.has(l.src);}
function editedSource(l) {const ctx=lineContext();return (ctx.editedAtByTurn.get(ctx.turnByOrder.get(l.src)) ?? 0)>l.at;}
const newCount = e => linesOf(e).filter(l => l.at > (seen()[e.id] ?? 0)).length;
export function initLorebookView() {
  window.addEventListener('popstate',event => {
    if (!opened || !navigationId) return;
    const nav = event.state?.neraLore;
    if (nav?.id && nav.id !== navigationId) return;
    if (!canLeave()) { pushNavigation(); return; }
    fromHistory = true;
    try {
      if (!nav || nav.id !== navigationId) { navigationDepth = 0; view.hide(); return; }
      navigationDepth = nav.depth; navigationKey = nav.key; screen = nav.screen; book = nav.book; staged = base = null; selected = nav.selected;
      const entry = selected && entries().find(e => e.id === selected); if (entry) { base = structuredClone(entry); staged = structuredClone(entry); }
      renderShell();
    } finally { fromHistory = false; }
  });
  document.addEventListener('memory-rebuild-review',async e=>{const d=e.detail;if(d.sessionId!==state.sessionId || !confirm(`${d.count} old notes were not reproduced by the rebuild. Remove them? A backup will be made.`))return;try{const snapshot=memorySnapshot(d.sessionId);if(!snapshot)return;const backup=await store.removeReviewedLines(d.sessionId,snapshot.entries,d.fromOrder,d.throughOrder);if(backup)toast('Unreproduced notes removed.','Undo',()=>store.restoreBackup(d.sessionId,backup,memorySnapshot(d.sessionId)?.entries ?? []));}catch(error){toast(error.message);}});
  document.addEventListener('lorebooks',e => openLorebooks(e.detail ?? {}));
  document.addEventListener('lore-changed',e => {
    if (!opened || e.detail.sessionId !== sid) return;
    sizes.clear();
    if (staged) {
      const current = entries().find(e => e.id === selected);
      if (current) { const oldIds = new Set(linesOf(base).map(l => l.id)), fresh = linesOf(current).filter(l => !oldIds.has(l.id));
        for (const [key,section] of Object.entries(current.sections)) { const container = editor?.querySelector('[data-section="'+key+'"]'); if (!container) continue; container.querySelector('.concurrent-lines')?.remove(); const arrived = section.lines.filter(l => !oldIds.has(l.id)); if (arrived.length) { const extra = node('div',null,'concurrent-lines'); for (const ln of sortLines(arrived)) extra.append(node('p',`+new · T${ln.turn ?? ''}${ln.when ? ' · '+ln.when : ''} · ${ln.text}`,'muted')); container.append(extra); } }
        const notice = editor?.querySelector('.concurrent-notice'); if (notice) notice.textContent = fresh.length ? `${fresh.length} new notes arrived while you were editing. They'll be kept when you save.` : '';
      }
    }
    if (!staged && pendingEntryId) { const e = entries().find(e => e.id === pendingEntryId); if (e) { pendingEntryId = null; openCard(e); } }
    renderRail(); renderList();
  });
  document.addEventListener('session-changed',e => { if (opened && e.detail.sessionId !== sid) closeManager(true); });
  document.addEventListener('memory-toast',e => toast(e.detail.text,e.detail.action,() => document.dispatchEvent(new CustomEvent(e.detail.event,{ detail:e.detail.options }))));
  document.addEventListener('keydown',e => { if (!opened) return; if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (staged) void saveCard(); } if (e.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); list?.querySelector('input')?.focus(); } });
}
export function openLorebooks(options = {}) {
  if (opened) {
    if (!canLeave()) return;
    if (sid === state.sessionId) {
      staged = base = null; selected = null; book = options.book ?? book; filter = options.filter ?? 'all'; screen = options.screen ?? 'list';
      renderShell();
      const entry = options.entryId && entries().find(e => e.id === options.entryId); if (entry) openCard(entry);
      if (options.newName) void newCard(options.newName);
      return;
    }
    fromHistory = true; view.hide(); fromHistory = false;
  }
  opened = true; navigationId = newLoreId('nav'); navigationDepth = 0; navigationKey = null; sid = state.sessionId; book = options.book ?? 'characters'; filter = options.filter ?? 'all'; selected = null; staged = base = null; search = ''; screen = options.screen ?? 'books'; newPrefill = options.newName; pendingEntryId = options.entryId ?? null;
  view = sheet(document.getElementById('lorebook-overlay'),'LOREBOOKS · '+(live()?.session.title ?? ''),{ className:'lore-sheet',close:() => { if (!canLeave()) return false; opened = false; staged = base = null; if (!fromHistory && navigationDepth && window.history?.go) window.history.go(-navigationDepth); navigationDepth = 0; document.dispatchEvent(new CustomEvent('lorebook-visibility',{ detail:{ open:false } })); return true; },back:hide => { if (!canLeave()) return; staged = base = null; if (navigationDepth > 1 && window.history?.back) { window.history.back(); return; } if (screen === 'editor') { screen = 'list'; selected = null; renderShell(); } else if (screen === 'list' || screen === 'transfer' || screen === 'backups') { screen = 'books'; renderShell(); } else hide(); } });
  document.dispatchEvent(new CustomEvent('lorebook-visibility',{ detail:{ open:true } }));
  renderShell();
  void prepareMemorySnapshot().then(() => { if (opened && sid === state.sessionId) { renderRail(); renderList(); } }).catch(e => toast(e.message));
  if (options.entryId) { const e = entries().find(e => e.id === options.entryId); if (e) { book = e.book; openCard(e); } }
  if (options.newName) void newCard(options.newName);
}
function closeManager(force = false) { if (force) staged = base = null; return view?.hide(); }
function renderShell() {
  const key = [screen,book,selected].join(':');
  if (!fromHistory && key !== navigationKey) pushNavigation(key);
  view.dialog.querySelector('.memory-content')?.remove();
  const body = node('div',null,'memory-content lore-body'); body.dataset.screen = screen; view.dialog.append(body);
  if (!sid) { body.append(node('p','Open a story to see its lorebooks.','muted')); return; }
  if (!live()?.session.memory?.lorebooks) { const banner = node('div',null,'lore-banner'); banner.append(node('span',"Lorebooks aren't used in replies for this story yet."),button('Turn on in Memory settings',() => { if (closeManager()) document.dispatchEvent(new CustomEvent('memory-settings')); },'btn small')); body.append(banner); }
  rail = node('nav',null,'lore-rail'); rail.setAttribute('aria-label','Lorebooks');
  const columns = node('div',null,'lore-columns');columns.id='lorebook-columns'; list = node('div',null,'lore-list'); editor = node('div',null,'lore-editor');
  columns.append(rail,list,editor); body.append(columns); renderRail();
  if (screen === 'transfer') renderTransfer(); else if (screen === 'backups') void renderBackups(); else { renderList(); if (staged) renderEditor(); else editor.append(node('p','Choose a card to read or edit.','muted')); }
}
function renderRail() {
  if (!rail) return; rail.replaceChildren();
  for (const [key,label] of Object.entries(BOOK_LABELS)) {
    const cards = entries().filter(e => e.book === key), drafts = cards.filter(e => e.draft).length, openThreads = cards.filter(e => e.kind === 'thread' && e.status !== 'closed').length;
    const b = button(label+' · '+cards.length,() => { if (!canLeave()) return; book = key; screen = 'list'; selected = null; staged = base = null; search = ''; renderShell(); },'btn lore-book'+(key === book ? ' selected' : ''));
    b.setAttribute('aria-controls','lorebook-columns');b.setAttribute('aria-expanded',String(key===book && screen==='list'));
    b.append(node('small',key === 'events' ? openThreads+' open threads' : drafts ? drafts+' to review' : live()?.session.memory?.books?.[key]?.on === false ? 'Not used' : '')); rail.append(b);
  }
  rail.append(button('Import & export',() => { if (!canLeave()) return; staged = base = null; screen = 'transfer'; renderShell(); }),button('Backups',() => { if (!canLeave()) return; staged = base = null; screen = 'backups'; renderShell(); }));
}
function needsReview(l) { return noteNeedsReview(l,live()?.messages ?? [],live()?.session ?? {}); }
function passes(e,f) { return f === 'needs-review' && (linesOf(e).some(needsReview) || Object.values(e.sections).some(s => snapshotNeedsReview(s,e,live()?.session))) || f === 'all' || f === 'review' && e.draft || f === 'new' && newCount(e)>0 || f === 'always' && e.alwaysLoad || f === 'big' && (sizes.get(e.id) ?? 0)>normalizeMemory(live()?.session.memory).books[e.book].budget || f === 'deleted' && linesOf(e).some(deletedLine); }
function badge(text,kind = '') { return node('span',text,'badge '+kind); }
function renderList() {
  if (!list || ['transfer','backups'].includes(screen)) return;
  list.replaceChildren(); list.append(button('‹ Books',() => { if (!canLeave()) return; staged = base = null; screen = 'books'; renderShell(); },'btn small mobile-back'));
  list.append(node('h3',BOOK_LABELS[book]));
  if (book === 'events') {
    const tabs = node('div',null,'segmented');
    tabs.append(button('Timeline',() => { const timeline = entries().find(e => e.kind === 'timeline'); if (timeline) openCard(timeline); else void newCard('Timeline','timeline'); }),button('Threads',() => { selected = null; staged = base = null; renderList(); })); list.append(tabs);
    const status = node('select'); for (const value of ['open','closed','all']) { const o = node('option',value[0].toUpperCase()+value.slice(1)); o.value = value; status.append(o); } status.value = threadFilter; status.addEventListener('change',() => { threadFilter = status.value; renderList(); }); list.append(status);
  }
  const searchField = field('Search names…',search); searchField.input.addEventListener('input',() => { search = searchField.input.value; renderRows(rows); }); list.append(searchField.wrap);
  const books = entries().filter(e => e.book === book);
  const filters = node('div',null,'lore-filters');
  const renderFilters = () => { filters.replaceChildren();
  for (const [value,label] of [['all','All'],['review','Draft cards'],['needs-review','Needs review'],['new','New'],['always','Always'],['big','Too big'],['deleted','From deleted turns']]) { const count = books.filter(e => passes(e,value)).length; if (!count && value !== 'all') continue; filters.append(button(label+' '+count,() => { filter = value; renderList(); },'btn small'+(filter === value ? ' selected' : ''))); } }; renderFilters(); list.append(filters);
  const rows = node('div',null,'lore-rows'); rows.setAttribute('role','listbox'); rows.setAttribute('aria-label',BOOK_LABELS[book]); list.append(rows); renderRows(rows);
  const edited=live()?.session.memoryState?.rebuildFromOrder;if(live()?.session.memoryState?.needsRebuild && edited!=null){const t=computeTurns(live().messages).turnById.get(live().messages.find(m=>m.order===edited)?.id) ?? '?';list.append(button('History edited at T'+t+' · Re-extract from there',async()=>{if(!confirm('Re-extract this edited history? Generated notes will be backed up and marked for review.'))return;await rebuildFrom(sid,edited);toast('Re-extraction finished; prior notes remain for review.');}));}
  list.append(button('Rebuild generated memory',async () => { try {const snapshot = live(),mem=normalizeMemory(snapshot.session.memory),turns=computeTurns(snapshot.messages); const eligible=turns.assistants.slice(0,Math.max(0,turns.assistants.length-mem.lagTurns)); if(!confirm(`Rebuild will re-read ${eligible.length} turns in about ${Math.ceil(eligible.length/mem.batchTurns)} model calls and mark generated notes for review. Continue?`))return; const finished=await rebuild(snapshot.session.id); toast(finished ? 'Memory rebuild finished; prior notes remain for review.' : 'Memory rebuild stopped. '+(live()?.session.memoryState?.lastError ?? 'Saved updates are kept.'));}catch(e){toast(e.message);} },'btn small'));
  list.append(button('+ New',() => newCard(newPrefill ?? ''),'btn primary'),button('Reorganize book…',() => reorganize(entries().filter(e => e.book === book)),'btn small'));
  if (filter === 'deleted') { const affected = books.filter(e => passes(e,'deleted')), count = affected.reduce((n,e) => n+linesOf(e).filter(deletedLine).length,0); if (count) list.append(button('Remove all '+count,async () => { if (!confirm('Remove all '+count+' notes from deleted turns?')) return; await undoAction(await store.removeDeletedLines(sid,affected,deletedOrders()),'Removed '+count+' notes.'); },'btn danger')); }
  const missing = books.filter(e => !sizes.has(e.id));
  if (missing.length) void Promise.all(missing.map(async e => { const text = renderEntry(e), tokens = await countTokens(text); if (renderEntry(entries().find(x => x.id === e.id) ?? e) === text) sizes.set(e.id,tokens); })).then(() => { if (list?.querySelector('.lore-rows') === rows) { renderFilters(); renderRows(rows); } });
}
function renderRows(rows) {
  rows.replaceChildren(); const cards = entries().filter(e => e.book === book && (book !== 'events' || e.kind === 'thread' && (threadFilter === 'all' || e.status === threadFilter)) && passes(e,filter) && normSearch([e.name,...e.aliases].join(' ')).includes(normSearch(search))).sort((a,b) => Number(b.alwaysLoad)-Number(a.alwaysLoad)||Number(b.draft)-Number(a.draft)||Math.max(0,...linesOf(b).map(l => l.at))-Math.max(0,...linesOf(a).map(l => l.at)));
  if (!cards.length) {
    const messages = { characters:"No characters yet. They'll appear here as your story introduces them (with Automatic memory updates on), or add one yourself.",locations:'No places yet. The current place from the scene line is loaded each turn once it has a card.',facts:"No world facts yet. Add the rules of your world — magic, calendar, politics. They're sent every turn.",events:'No open threads. Unresolved goals, promises and mysteries appear here.' };
    rows.append(node('p',search || filter !== 'all' ? 'No matching cards.' : messages[book],'muted')); return;
  }
  for (const e of cards) {
    const row = button('',() => openCard(e),'lore-list-item'); row.setAttribute('role','option'); row.setAttribute('aria-selected',String(selected === e.id)); row.append(node('strong',e.name),node('small',e.aliases.join(', '),'muted'),node('span',sizes.has(e.id) ? (sizes.get(e.id)/1000).toFixed(1)+'k' : '…','muted'));
    const badges = node('div',null,'lore-badges'); if (e.alwaysLoad) badges.append(badge('Always','always')); if (e.draft) badges.append(badge('Draft','draft')); if (newCount(e)) badges.append(badge('+'+newCount(e)+' new','new')); if (passes(e,'big')) badges.append(badge('Too big to send in full','warn')); if (passes(e,'deleted')) badges.append(badge('From deleted turns','warn')); row.append(badges); rows.append(row);
    row.addEventListener('keydown',ev => { if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); const options = [...rows.children]; options[Math.max(0,Math.min(options.length-1,options.indexOf(row)+(ev.key === 'ArrowDown' ? 1 : -1)))].focus(); } });
  }
}
async function newCard(prefill = '',kind = 'card') {
  if (!canLeave()) return;
  const s = subSheet('+ New '+(book === 'facts' ? 'topic' : book === 'events' && kind !== 'timeline' ? 'thread' : 'card'));
  const name = field('Name',prefill), status = node('p','','memory-warning');
  const body = node('div',null,'memory-content'); body.append(name.wrap,status);
  const save = button('Create',async () => {
    const value = name.input.value.trim().slice(0,60); if (!value) return;
    const exists = entries().find(e => e.book === book && [e.name,...e.aliases].some(n => normalizeName(n) === normalizeName(value)));
    if (exists) { status.replaceChildren(node('span',`A card named ${value} already exists.`),button('Open it',() => { s.hide(); openCard(exists); })); return; }
    const e = makeEntry(book,value,{ kind:book === 'events' ? kind === 'timeline' ? 'timeline' : 'thread' : 'card',status:book === 'events' && kind !== 'timeline' ? 'open' : null });
    if (state.busy) throw new Error('Wait for the current reply or summary.');
    save.disabled = true; await store.createEntry(sid,e); s.hide(); openCard(e);
  },'btn primary'); body.append(save,button('Cancel',s.hide)); name.input.addEventListener('keydown',e => { if (e.key === 'Enter') save.click(); }); s.dialog.append(body); name.input.focus();
}
function openCard(e) {
  if (!canLeave()) return;
  book = e.book;
  if (screen !== 'list' && screen !== 'editor') { screen = 'list'; renderShell(); }
  selected = e.id; screen = 'editor'; base = structuredClone(e); staged = structuredClone(e); const read = seen(); read[e.id] = Date.now(); try { localStorage.setItem(seenKey(),JSON.stringify(read)); } catch { /* Read state is optional on private devices. */ } renderShell();
  if (e.kind === 'timeline') editor.scrollTop = editor.scrollHeight;
}
function renderEditor() {
  if (!editor || !staged) return;
  const version = ++editorVersion; editor.replaceChildren();
  editor.append(button('‹ '+BOOK_LABELS[book],() => { if (!canLeave()) return; staged = base = null; selected = null; screen = 'list'; renderShell(); },'btn small mobile-back'),node('h2',staged.name),node('p','','concurrent-notice muted'));
  if (staged.draft) {
    const banner = node('div',null,'lore-banner'); banner.append(node('p',`This card was created by a memory update (turn ${linesOf(staged)[0]?.turn ?? '?'}). Check it's a new character, not someone you already have.`),button('Keep',async () => { if (state.busy) throw new Error('Wait for the current reply or summary.'); const original = entries().find(e => e.id === staged.id) ?? base; await store.saveEntry(sid,{ ...original,draft:false },original); base.draft = false; staged.draft = false; renderEditor(); toast('Saved'); }),button('Merge into…',mergeCard),button('Delete',deleteCard)); editor.append(banner);
  }
  if (staged.kind !== 'timeline' && !['characters', 'locations'].includes(book)) { const name = field(staged.kind === 'thread' ? 'Title' : 'Main name',staged.name); name.input.maxLength = 60; name.input.addEventListener('input',() => staged.name = name.input.value); editor.append(name.wrap); }
  if (book === 'characters' || book === 'locations') {
    renderNameChips(editor);
    const always = field('Always load','',{ type:'checkbox' }); always.input.checked = staged.alwaysLoad; always.input.addEventListener('change',() => staged.alwaysLoad = always.input.checked); editor.append(always.wrap,node('p',"Load this card every turn, even when it isn't mentioned.",'muted'));
  }
  if (staged.kind === 'thread') { const status = field('Status',''); const select = node('select'); for (const value of ['open','closed']) { const o = node('option',value); o.value = value; select.append(o); } select.value = staged.status; select.addEventListener('change',() => staged.status = select.value); status.input.replaceWith(select); editor.append(status.wrap); }
  if (book === 'facts') editor.append(node('p',"World facts are sent every turn. Keep them short — rules, not stories.",'muted'));
  const protagonist = normalizeMemory(live()?.session.memory).protagonist, own = book === 'characters' && [staged.name,...staged.aliases].some(n => normalizeName(n) === normalizeName(protagonist));
  for (const key of SECTION_KEYS[book]) {
    if (key === 'bond' && own) continue;
    const section = staged.sections[key], container = node('section',null,'lore-section');
    const label = key === 'text' ? book === 'facts' ? 'Facts' : staged.kind === 'timeline' ? 'Backstory before the story starts (optional)' : 'Notes' : sectionLabel(key,protagonist)+(key === 'personality' ? ' · ONLY YOU WRITE' : '');
    container.append(node('h3',label,'eyebrow'));
    Object.assign(section,sectionMeta(section,staged));
    if (snapshotNeedsReview(section,staged,live()?.session)) container.append(node('p','Needs review: snapshot excluded after a history change. Assign a verified cutoff or declare author canon.','memory-warning'));
    const classification = node('select');
    for (const kind of ['canon','snapshot','background']) { const option = node('option',kind === 'canon' ? 'Author canon' : kind === 'snapshot' ? 'State snapshot' : 'Background (unknown cutoff)'); option.value = kind; classification.append(option); }
    classification.value = section.kind;
    const cutoff = field('Snapshot cutoff: narrator turn',section.cutoff?.turn ?? ''); cutoff.input.type = 'number'; cutoff.input.min = '1';
    const updateKind = () => { section.kind = classification.value; section.origin = 'user'; section.unavailable = false; section.sourceRevision = live()?.session.historyRevision ?? 0; cutoff.wrap.hidden = section.kind !== 'snapshot'; };
    classification.addEventListener('change',updateKind); cutoff.wrap.hidden = section.kind !== 'snapshot';
    cutoff.input.addEventListener('input',() => { const turn = Number(cutoff.input.value), assistant = computeTurns(live()?.messages ?? []).assistants.find(a => a.turn === turn); section.cutoff = assistant ? { turn,order:assistant.order } : null; section.unavailable = false; section.sourceRevision = live()?.session.historyRevision ?? 0; });
    container.append(classification,cutoff.wrap);

    const text = field('Your text',section.text,{ textarea:true }); text.input.placeholder = key === 'personality' ? 'How they think and behave. Only you write here — memory updates never touch it.' : 'Your description (optional). Updates below add to it.'; text.input.addEventListener('input',() => { section.text = text.input.value; void updateFooter(); });
    if (staged.kind === 'timeline') { const d = node('details'); d.append(node('summary','Backstory before the story starts (optional)'),text.wrap); container.append(d); } else container.append(text.wrap);
    if (own && key === 'relations') container.append(node('p',"This is the protagonist's own card.",'muted'));
    if (staged.kind === 'timeline' && !section.lines.length) container.append(node('p','No events yet. Important moments will be added here every few turns.','muted'));
    const lineList = node('div',null,'lore-lines'); lineList.dataset.section = key; let expanded = false;
    const renderLines = () => {
      lineList.replaceChildren(); const ordered = sortLines(section.lines); if (ordered.length) lineList.append(node('p','Updates · source turn order','muted'));
      if (ordered.length > 8 && !expanded) lineList.append(button('Show '+(ordered.length-8)+' older',() => { expanded = true; renderLines(); },'btn small'));
      let date = null;
      for (const ln of expanded ? ordered : ordered.slice(-8)) {
        if (staged.kind === 'timeline' && ln.when !== date) { date = ln.when; if (date) lineList.append(node('p',date,'muted')); }
        const row = node('div',null,'line-row');
        const lastSent = live()?.report?.loaded.find(e => e.entryId === staged.id);
        if (lastSent && !lastSent.lineIds?.includes(ln.id)) { row.classList.add('dim'); row.title = 'Not sent last turn (book budget)'; }
        const stamp = node('span',[ln.turn != null ? 'T'+ln.turn : '',ln.when].filter(Boolean).join(' · '),'stamp'); stamp.title = ln.by === 'auto' ? 'Added by memory update · turn '+ln.turn : ln.by === 'user' ? 'Added by you' : ln.by === 'import' ? 'Imported' : 'Reorganized'; row.append(stamp,node('span',ln.text));
        if (needsReview(ln)) row.append(badge('Needs review','warn'));
        if (deletedLine(ln)) row.append(badge('From deleted turn','warn')); else if (editedSource(ln)) row.append(badge('Source edited'));
        const menu = node('details',null,'line-menu'); menu.append(node('summary','⋯'));
        menu.append(button('Edit',() => editLine(ln,row,key,renderLines),'btn small'),button('Move into my text',() => { section.text += (section.text ? '\n' : '')+ln.text; text.input.value = section.text; section.lines = section.lines.filter(l => l.id !== ln.id); renderLines(); void updateFooter(); },'btn small'),button('Delete',() => { section.lines = section.lines.filter(l => l.id !== ln.id); renderLines(); void updateFooter(); },'btn small danger')); row.append(menu); lineList.append(row);
      }
    }; renderLines(); container.append(lineList,button('+ Add line',() => { const turns = computeTurns(live()?.messages ?? []), when = latestScene(live()?.messages ?? []).scene?.when ?? null; const ln = { id:newLoreId('ln'),text:'',turn:turns.lastTurn,when,src:null,by:'user',at:Date.now() }; section.lines.push(ln); renderLines(); const row = lineList.lastElementChild; if (row) editLine(ln,row,key,renderLines); },'btn small')); editor.append(container);
  }
  const footer = node('footer',null,'memory-actions'); footer.id = 'lore-editor-footer';
  const tokenLabel = node('span','','muted'); tokenLabel.title = 'Cards larger than the book budget are sent with only their newest lines.'; footer.append(tokenLabel);
  async function updateFooter() { const tokens = await countTokens(renderEntry(staged)), budget = normalizeMemory(live()?.session.memory).books[book].budget; if (version !== editorVersion) return; tokenLabel.textContent = `${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens · ${linesOf(staged).length} lines`; tokenLabel.style.color = tokens>budget ? 'var(--danger)' : ''; if (new TextEncoder().encode(JSON.stringify(staged)).length > 700000) tokenLabel.textContent += ' · Too big to store much longer — reorganize it'; }
  const reorganizeBtn = button('Reorganize…',() => { if (dirty()) { toast('Save or cancel your changes before reorganizing.'); return; } return reorganize([entries().find(e => e.id === selected) ?? staged]); }); reorganizeBtn.disabled = linesOf(staged).filter(l => l.by !== 'user').length < 3; reorganizeBtn.title = reorganizeBtn.disabled ? 'Nothing to tidy yet' : '';
  const save = button('Save',saveCard,'btn primary'); save.disabled = reorganizing.has(staged.id);
  footer.append(reorganizeBtn,button('Merge into…',mergeCard),button('Duplicate name check',() => toast(aliasWarnings(staged).join(' · ') || 'No duplicate names.')),button('Delete card',deleteCard,'btn danger'),button('Cancel',() => { staged = structuredClone(base); renderEditor(); }),save); editor.append(footer); void updateFooter();
}
function aliasWarnings(e) {
  const warnings = []; for (const n of [e.name,...e.aliases]) { if (n.length<3 || STOPLIST.has(normalizeName(n))) warnings.push('Very short names can match by accident: '+n); const clash = entries().find(x => x.book === e.book && x.id !== e.id && [x.name,...x.aliases].some(a => normalizeName(a) === normalizeName(n))); if (clash) warnings.push('Also used by '+clash.name+': '+n); } return warnings;
}
function editLine(ln,row,key,renderLines) {
  row.replaceChildren(); const turn = field('Turn',ln.turn ?? ''), when = field('Date',ln.when ?? ''), text = field('Note',ln.text,{ textarea:true }); turn.input.inputMode = 'numeric'; turn.input.addEventListener('input',() => turn.input.value = turn.input.value.replace(/\D/g,''));
  row.append(turn.wrap,when.wrap,text.wrap,button('Save line',() => { if (!text.input.value.trim()) return; if (turn.input.value && !Number.isSafeInteger(Number(turn.input.value))) throw new Error('Enter a valid turn number.'); Object.assign(ln,{ text:text.input.value.trim(),turn:turn.input.value ? Number(turn.input.value) : null,when:when.input.value.trim() || null,by:'user' }); renderLines(); }),button('Cancel',renderLines)); text.input.focus();
}
async function saveCard() {
  if (!staged || reorganizing.has(staged.id)) return;
  if (!staged.name.trim()) throw new Error('Enter a name.');
  if (linesOf(staged).some(l => !l.text.trim())) throw new Error('Finish or delete empty update lines.');
  const saved = structuredClone(staged), original = structuredClone(base);
  if (state.busy) throw new Error('Wait for the current reply or summary.');
  await store.saveEntry(sid,saved,original); base = structuredClone(saved); staged = structuredClone(saved); sizes.delete(saved.id); toast('Saved'); renderEditor();
}
async function undoAction(id,text) { toast(text,'Undo',async () => { await store.restoreBackup(sid,id,entries()); toast('Restored'); }); }
async function deleteCard() { if (state.busy) throw new Error('Wait for the current reply or summary.'); const e = entries().find(e => e.id === selected) ?? staged; if (!confirm(`Delete the card '${e.name}' and its ${linesOf(e).length} notes?`)) return; const backup = await store.deleteEntry(sid,e); staged = base = null; selected = null; screen = 'list'; renderShell(); await undoAction(backup,'Deleted '+e.name+'.'); }
async function mergeCard() {
  if (dirty()) { toast('Save or cancel your changes before merging.'); return; }
  if (state.busy) throw new Error('Wait for the current reply or summary.');
  const source = entries().find(e => e.id === selected) ?? staged, s = subSheet('Merge '+source.name+' into…'), body = node('div',null,'memory-content'), search = field('Search names…',''), results = node('div');
  const render = () => { results.replaceChildren(); for (const target of entries().filter(e => e.book === source.book && e.kind === source.kind && e.id !== source.id && normSearch(e.name).includes(normSearch(search.input.value)))) results.append(button(target.name,async () => { if (!confirm(`Merge '${source.name}' into '${target.name}'? Its notes move over and '${source.name}' becomes another name for ${target.name}.`)) return; const backup = await store.mergeEntries(sid,source,target); s.hide(); staged = base = null; openCard(target); await undoAction(backup,'Merged into '+target.name+'.'); })); }; search.input.addEventListener('input',render); body.append(search.wrap,results); s.dialog.append(body); render();
}
function renderTransfer() {
  list.replaceChildren(); editor.replaceChildren(); list.append(button('‹ Books',() => { screen = 'books'; renderShell(); },'btn mobile-back'),node('h2','Import & export'));
  let format = localStorage.getItem('nera.lore.format') === 'json' ? 'json' : 'md';
  const segmented = node('div',null,'segmented'), md = button('Markdown',() => changeFormat('md')), json = button('JSON',() => changeFormat('json')); segmented.append(md,json); list.append(segmented);
  function changeFormat(value) { format = value; localStorage.setItem('nera.lore.format',value); md.classList.toggle('selected',value === 'md'); json.classList.toggle('selected',value === 'json'); picker.accept = value === 'md' ? '.md,.markdown,.txt' : '.json'; }
  const checks = {};
  editor.append(node('h3','Export'));
  for (const [key,label] of Object.entries(BOOK_LABELS)) { const f = field(label,'',{ type:'checkbox' }); f.input.checked = true; checks[key] = f.input; editor.append(f.wrap); }
  editor.append(button('Export lorebooks',() => { const title = live()?.session.title ?? 'story', books = Object.keys(checks).filter(k => checks[k].checked), text = format === 'md' ? toMarkdown(entries(),{ title,books }) : toJson(entries(),{ title,books }); download(text,title.replace(/[^\p{L}\p{N} _-]/gu,'')+'-lorebooks-'+new Date().toISOString().slice(0,10)+'.'+(format === 'md' ? 'md' : 'json')); }),button('Export transcript for lorebooks (.txt)',async () => { const snapshot = await prepareMemorySnapshot(); download(formatTurnsTranscript(snapshot.messages,computeTurns(snapshot.messages),{ title:snapshot.session.title,protagonist:normalizeMemory(snapshot.session.memory).protagonist }),snapshot.session.title+'-transcript.txt'); }));
  editor.append(node('h3','Import'));
  const mode = node('select'), conflict = node('select'); for (const [value,label] of [['merge','Add and merge — keeps everything you have'],['replace','Replace the books in the file — a backup is made first']]) { const o = node('option',label); o.value = value; mode.append(o); }
  for (const [value,label] of [['mine','Keep mine'],['file',"Use the file's"],['both','Keep both']]) { const o = node('option',label); o.value = value; conflict.append(o); }
  const modeLabel = node('label','Mode'); modeLabel.append(mode); const conflictLabel = node('label',"When my text and the file's text differ:"); conflictLabel.append(conflict); editor.append(modeLabel,conflictLabel);
  const picker = node('input'); picker.type = 'file'; picker.className = 'hidden'; picker.addEventListener('change',async () => { const file = picker.files[0]; picker.value = ''; if (!file) return; if (file.size>2*1024*1024) { toast('The file is larger than 2 MB. Split it by book.'); return; } await readImport(await file.text()); }); editor.append(picker,button('Choose file…',() => picker.click()),button('Paste text',() => {
    const s = subSheet('Paste lorebooks'), body = node('div',null,'memory-content'), text = field('Lorebooks','',{ textarea:true }); text.input.rows = 16;
    body.append(text.wrap,button('Read',async () => { if (await readImport(text.input.value)) s.hide(); },'btn primary'),button('Cancel',s.hide)); s.dialog.append(body);
  }));
  changeFormat(format);
  async function readImport(text) {
    if(new TextEncoder().encode(text).length>2*1024*1024){toast('The file is larger than 2 MB. Split it by book.');return false;}
    try {
      const detected = detectFormat(text), parsed = detected === 'json' ? fromJson(text) : fromMarkdown(text,{ protagonist:normalizeMemory(live()?.session.memory).protagonist });
      let plan = planImport(entries(),parsed,{ mode:mode.value,conflict:conflict.value });
      const s = subSheet('IMPORT PREVIEW · Read as '+(detected === 'md' ? 'Markdown' : 'JSON')), body = node('div',null,'memory-content');
      for (const [key,stats] of Object.entries(plan.preview.books)) {
        const d = node('details'); d.append(node('summary',BOOK_LABELS[key]+': '+stats.new+' new · '+stats.merged+' merged · '+stats.unchanged+' unchanged'+(key === 'events' ? ` · ${stats.events} events · ${stats.open} open threads · ${stats.closed} closed` : ''))); for (const card of stats.cards) d.append(node('p',card.name+' · '+card.type,'muted')); body.append(d);
      }
      if (plan.preview.conflicts) body.append(node('p',`Your text conflicts: ${plan.preview.conflicts} (${conflict.selectedOptions[0].textContent})`,'muted'));
      for (const w of plan.preview.warnings) body.append(node('p',`Line ${w.line}: ${w.reason}`,'memory-warning'));
      body.append(button('Cancel',s.hide),button('Import',async b => { if (state.busy) { toast('Wait for the current reply or summary.'); return; } b.disabled = true;
        // Replan after the preview so newly arrived notes are never lost.
        plan = planImport(entries(),parsed,{ mode:mode.value,conflict:conflict.value }); const backup = await store.importLore(sid,plan,entries()); s.hide();
        const stats = plan.preview.books; await undoAction(backup,`Imported ${stats.characters?.new ?? 0} characters, ${stats.locations?.new ?? 0} places, ${stats.facts?.new ?? 0} facts, ${stats.events?.events ?? 0} events.`);
      },'btn primary')); s.dialog.append(body); return true;
    } catch (e) { toast(e.message); return false; }
  }
  const protagonist = normalizeMemory(live()?.session.memory).protagonist;
  editor.append(node('h3','Make lorebooks with an AI'),node('p','Protagonist: '+(protagonist || 'the main character'),'muted'));
  const prompt = () => fillProtagonist(format === 'md' ? LOREBOOK_TEMPLATE_MD : LOREBOOK_TEMPLATE_JSON,protagonist);
  editor.append(button('Copy prompt for an AI',async () => { await copy(prompt()); toast('Prompt copied'); })); const disclosure = node('details'); disclosure.append(node('summary','Show prompt'),node('pre',prompt())); editor.append(disclosure,node('p','1. Export this story (Settings → Import & export → Export current story), or export the transcript above.\n2. Paste the prompt and the file into an AI chat.\n3. Save its answer as a .md (or .json) file and import it here.','muted'));
}
async function renderBackups() {
  list.replaceChildren(); editor.replaceChildren(); list.append(node('h2','Backups')); const groups = await store.listBackups(sid);
  for (const b of groups) {
    const row = node('div',null,'lore-list-item'); row.append(node('p',b.label+' · '+new Date(b.createdMs).toLocaleString()+' · '+b.count+' cards'),button('Restore',async () => {
      const all=await store.loadBackupGroup(sid,b.id),saved=all.flatMap(x=>x.entries),createdIds=all.flatMap(x=>x.createdIds ?? []);
      const ids = new Set(saved.flatMap(e => linesOf({ sections:e.data.sections }).map(l => l.id))), count = entries().filter(e => saved.some(s => s.id === e.id) || createdIds.includes(e.id)).reduce((n,e) => n+linesOf(e).filter(l => !ids.has(l.id)).length,0);
      if (!confirm(`Restore ${saved.length} card(s) to how they were on ${new Date(b.createdMs).toLocaleString()}? Notes added since then to these cards will be removed (${count} notes).`)) return;
      await store.restoreBackup(sid,b.partOf ?? b.id,entries()); toast('Restored'); void renderBackups();
    })); list.append(row);
  }
  if (!groups.length) list.append(node('p','No backups yet. Backups are made before destructive changes.','muted'));
}
async function reorganize(cards) {
  if (!cards.length) return;
  if (dirty()) { toast('Save or cancel your changes before reorganizing.'); return; }
  const snapshot = await prepareMemorySnapshot(), mem = normalizeMemory(snapshot.session.memory), snapshotAt = Date.now(), controller = new AbortController();
  const locked = cards.map(e => e.id), s = subSheet(cards.length === 1 ? 'Reorganize '+cards[0].name : 'Reorganize book',{ close:() => { controller.abort(); for (const id of locked) reorganizing.delete(id); return true; } });
  const body = node('div',null,'memory-content'); s.dialog.append(body);
  body.append(node('p',`The model will merge ${cards.length === 1 ? cards[0].name+"'s" : 'these cards’'} update lines into fewer, up-to-date lines. Your own text is never changed. Lower lines win when notes disagree. You'll see a preview before anything is saved.`,'muted'));
  const selectedCards = {}, selectedSections = {};
  for (const e of cards) {
    const f = field(e.name,'',{ type:'checkbox' }); f.input.checked = cards.length === 1 || linesOf(e).length>15 || passes(e,'big'); selectedCards[e.id] = f.input; body.append(f.wrap);
    selectedSections[e.id] = {};
    for (const [key,section] of Object.entries(e.sections)) if (section.lines.some(l => l.by !== 'user')) { const check = field(sectionLabel(key,mem.protagonist) || 'Notes','',{ type:'checkbox' }); check.input.checked = true; selectedSections[e.id][key] = check.input; body.append(check.wrap); }
  }
  const instruction = field('Extra instruction (optional)',''); instruction.input.placeholder = 'e.g. drop clothing details, keep injuries'; body.append(instruction.wrap);
  const cost = node('p','Estimating…','muted'); body.append(cost); let plan;
  const getSections = () => Object.fromEntries(cards.map(e => [e.id,Object.entries(selectedSections[e.id]).filter(([,input]) => input.checked).map(([key]) => key)]));
  const build = async () => planReorganize({ ...snapshot,mem },cards.filter(e => selectedCards[e.id].checked),getSections(),instruction.input.value);
  async function estimate() { try { plan = await build(); cost.textContent = `${plan.batches.length} model call${plan.batches.length === 1 ? '' : 's'} · about ${plan.inputTokens.toLocaleString()} input tokens.`; } catch (e) { cost.textContent = e.message; } }
  body.addEventListener('change',estimate); void estimate();
  body.append(button('Cancel',s.hide),button('Reorganize',async b => {
    b.disabled = true;
    try {
      plan = await build(); if (!plan.batches.length) { b.disabled = false; return; }
      for (const id of locked) reorganizing.add(id);
      const sections = getSections(), extra = instruction.input.value, previews = [], warnings = [...plan.warnings]; let tail = '';
      body.replaceChildren(cost,button('Stop',() => controller.abort()));
      for (const [i,batch] of plan.batches.entries()) {
        if (controller.signal.aborted) break;
        cost.textContent = `Reorganizing ${i+1} of ${plan.batches.length}…`;
        try {
          const result = await runReorganizeBatch({ ...snapshot,mem },batch,sections,extra,{ signal:controller.signal,onDelta:t => { tail = (tail+t).slice(-2000); cost.textContent = `Reorganizing ${i+1} of ${plan.batches.length}…\n${tail}`; } });
          for (const preview of result.previews) {
            const original = cards.find(e => e.id === preview.entry.id), sent = batch.find(e => e.id === preview.entry.id);
            for (const key of Object.keys(preview.sections)) {
              const sentIds = new Set(sent.sections[key].lines.map(l => l.id));
              const untouched = original.sections[key].lines.filter(l => l.by !== 'user' && !sentIds.has(l.id));
              preview.sections[key] = [...untouched,...preview.sections[key]];
            }
            preview.snapshot=Object.fromEntries(Object.entries(original.sections).map(([key,section])=>[key,section.lines.map(l=>l.id)]));
            preview.entry = original;
          }
          previews.push(...result.previews); if (result.skipped.length) warnings.push(`${result.skipped.length} lines mentioned names that aren't part of these cards or couldn't be read and were ignored.`);
        } catch (e) { if (controller.signal.aborted && previews.length) break; throw e; }
      }
      if (!previews.length) throw new Error('Stopped. Nothing was changed.');
      preview(previews,warnings);
    } catch (e) {
      body.replaceChildren(node('p','Reorganize failed: '+e.message+' Nothing was changed.','memory-warning'));
      if (e.raw) { const d = node('details'); d.append(node('summary','Show raw answer'),node('pre',e.raw)); body.append(d); }
      body.append(button('Try again',() => { s.hide(); return reorganize(cards); }),button('Discard',s.hide));
    } finally { for (const id of locked) reorganizing.delete(id); if (staged) renderEditor(); }
  },'btn primary'));
  async function preview(previews,warnings) {
    body.replaceChildren(); const beforeTokens = (await Promise.all(previews.map(p => countTokens(renderEntry(p.entry))))).reduce((a,b) => a+b,0);
    const afterTokens = (await Promise.all(previews.map(p => countTokens(renderEntry({ ...p.entry,sections:Object.fromEntries(Object.entries(p.entry.sections).map(([k,v]) => [k,{ ...v,lines:p.sections[k] ?? v.lines }])) }))))).reduce((a,b) => a+b,0);
    const beforeCount = previews.reduce((n,p) => n+Object.keys(p.sections).reduce((n,k) => n+p.entry.sections[k].lines.length,0),0), afterCount = previews.reduce((n,p) => n+Object.values(p.sections).reduce((n,ls) => n+ls.length,0),0);
    body.append(node('p',`${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens · ${beforeCount} → ${afterCount} lines`));
    if (afterTokens >= beforeTokens) warnings.push('No savings: the result is longer than before.');
    for (const warning of warnings) body.append(node('p',warning,'memory-warning'));
    for (const p of previews) {
      const include = field('Include '+p.entry.name,'',{ type:'checkbox' }); include.input.checked = true; include.input.addEventListener('change',() => p.include = include.input.checked); body.append(include.wrap);
      for (const [key,after] of Object.entries(p.sections)) {
        const original = p.entry.sections[key].lines.filter(l => l.by !== 'user'); if (!after.length && original.length) body.append(node('p',`${sectionLabel(key,mem.protagonist) || 'Notes'} lost all its lines — check before saving.`,'memory-warning'));
        const section = node('section'); section.append(node('h3',`${sectionLabel(key,mem.protagonist) || 'Notes'} · ${original.length} lines → ${after.length} lines`));
        const columns = node('div',null,'reorganize-columns'), before = node('div',null,'reorganize-before'), afterView = node('div',null,'reorganize-after'); before.append(node('h4','Before'),node('pre',sortLines(original).map(l => 'T'+(l.turn ?? '')+' '+l.text).join('\n'))); afterView.append(node('h4','After'));
        const tabs = node('div',null,'segmented mobile-back'); tabs.append(button('Before',() => { before.classList.remove('mobile-hidden'); afterView.classList.add('mobile-hidden'); }),button('After',() => { afterView.classList.remove('mobile-hidden'); before.classList.add('mobile-hidden'); })); section.append(tabs); before.classList.add('mobile-hidden');
        const rows = node('div'); const render = () => { rows.replaceChildren(); for (const ln of after) { const f = field('T'+(ln.turn ?? ''),ln.text,{ textarea:true }); f.input.addEventListener('input',() => ln.text = f.input.value); f.wrap.append(button('×',() => { after.splice(after.indexOf(ln),1); render(); },'btn small')); rows.append(f.wrap); } }; render(); afterView.append(rows,button('+ Add line',() => { after.push({ id:newLoreId('ln'),text:'',turn:original.at(-1)?.turn ?? null,when:original.at(-1)?.when ?? null,src:original.at(-1)?.src ?? null,by:'reorganize',at:Date.now() }); render(); },'btn small'));
        const removed=original.filter(l=>(p.sent?.[key] ?? []).some(sent=>sent.id===l.id) && !after.some(n=>n.id===l.id || n.src!=null && n.src===l.src));
        if(removed.length){afterView.append(node('h4','Will be removed'));for(const old of removed){const keep=field('Keep: '+old.text,'',{type:'checkbox'});keep.input.addEventListener('change',()=>{if(keep.input.checked){if(!after.some(l=>l.id===old.id))after.push({...old});}else{const i=after.findIndex(l=>l.id===old.id);if(i>=0)after.splice(i,1);}render();});afterView.append(keep.wrap);}}
        columns.append(before,afterView); section.append(columns); body.append(section);
      }
      const current = entries().find(e => e.id === p.entry.id), fresh = current ? linesOf(current).filter(l => l.at>snapshotAt).length : 0; if (fresh) body.append(node('p',`${fresh} new notes arrived during reorganize. They'll be kept below the new lines.`,'muted'));
    }
    body.append(button('Discard',s.hide),button(previews.length>1 ? 'Save selected' : 'Save',async b => {
      if (state.busy) { toast('Wait for the current reply or summary.'); return; } const chosen = previews.filter(p => p.include); if (!chosen.length) return;
      if (chosen.some(p => Object.values(p.sections).some(ls => ls.some(l => !l.text.trim())))) { toast('Finish or delete empty lines.'); return; }
      b.disabled = true; const backup = await store.replaceLines(sid,chosen,snapshotAt); s.hide(); staged = base = null; screen = 'list'; renderShell(); await undoAction(backup,`${chosen.length === 1 ? chosen[0].entry.name : 'Books'} reorganized: ${beforeCount} → ${afterCount} lines.`);
    },'btn primary'));
  }
}

function renderNameChips(parent) {
  const host = node('div',null,'lore-names'), label = node('p','Names','eyebrow'); parent.append(label,host);
  function move(from,to) { const names = [staged.name,...staged.aliases]; if (to<0 || to>=names.length) return; const [item] = names.splice(from,1); names.splice(to,0,item); [staged.name,...staged.aliases] = names; render(); }
  function render() {
    host.replaceChildren();
    for (const [index,name] of [staged.name,...staged.aliases].entries()) {
      const chip = node('span',null,'lore-name-chip'); chip.draggable = true;
      const edit = button(name,() => {
        const dialog = subSheet('Edit name'), body = node('div',null,'memory-content'), f = field(index ? 'Other name' : 'Main name',name); f.input.maxLength=60;
        body.append(f.wrap,button('Save',() => { const value=f.input.value.trim(); if (!value) return; if (index) staged.aliases[index-1]=value; else staged.name=value; dialog.hide(); render(); },'btn primary'),button('Cancel',dialog.hide)); dialog.dialog.append(body);
      },'lore-link'); edit.addEventListener('keydown',e => { if (e.altKey && ['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); move(index,index+(e.key === 'ArrowLeft' ? -1 : 1)); } }); chip.append(edit);
      if (index) chip.append(button('×',() => { staged.aliases.splice(index-1,1); render(); },'btn small'));
      chip.addEventListener('dragstart',e => e.dataTransfer.setData('text/plain',String(index))); chip.addEventListener('dragover',e => e.preventDefault()); chip.addEventListener('drop',e => { e.preventDefault(); move(Number(e.dataTransfer.getData('text/plain')),index); });
      const clash = entries().find(e => e.book === book && e.id !== staged.id && [e.name,...e.aliases].some(n => normalizeName(n) === normalizeName(name)));
      if (clash) chip.append(badge('Also used by '+clash.name,'warn'));
      if (name.length<3 || STOPLIST.has(normalizeName(name))) chip.append(badge('Very short names can match by accident','warn'));
      host.append(chip);
    }
    const add = field('+ add name',''); add.input.maxLength=60; const append = () => { const name=add.input.value.trim(); if (!name) return; if (![staged.name,...staged.aliases].some(n => normalizeName(n) === normalizeName(name))) staged.aliases.push(name); render(); };
    add.input.addEventListener('keydown',e => { if (e.key === 'Enter') { e.preventDefault(); append(); } }); host.append(add.wrap,button('+ add name',append,'btn small'));
    host.append(node('small','Drag to reorder, or use Alt + Left/Right on a name. The first name is the main name.','muted'));
  } render();
}

function pushNavigation(key = [screen,book,selected].join(':')) {
  if (!window.history?.pushState || !navigationId) return;
  navigationKey = key; navigationDepth++;
  window.history.pushState({ ...window.history.state, neraLore:{ id:navigationId,depth:navigationDepth,key,screen,book,selected } }, '');
}
