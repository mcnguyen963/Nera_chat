import {effectiveActiveSettings} from '../story-settings-store.js';
import {computeTurns} from '../turns.js';
import {normalizeMemory, anyMemory} from '../memory-settings.js';
import {BOOK_LABELS} from '../lore-format.js';
import {state} from '../state.js';
import {buildContextForRequest} from '../context-builder.js';
import {memorySnapshot, prepareMemorySnapshot} from './chat-view.js';
import {lastRawAnswer, updateNow, isRunning} from '../memory-updater.js';
import {node, button, sheet, copy, toast} from './memory-ui.js';
let open = false, version = 0, timer, viewedSession;
const expanded = new Map(), scrollPositions = new Map();

export function initContextViewer() {
  document.addEventListener('context-details', openContextViewer);
  document.getElementById('chat-input').addEventListener('input', () => {
    if (open) { clearTimeout(timer); timer = setTimeout(render, 400); }
  });
  for (const event of ['lore-changed','memory-refresh','session-changed','settings-changed','story-settings-changed']) {
    document.addEventListener(event, () => { if (open) void render(); });
  }
}
export function openContextViewer() {
  if (open) return;
  open = true;
  sheet(document.getElementById('context-viewer'), 'NEXT REQUEST', {className:'context-sheet', close:() => {
    rememberView(); open = false; ++version; clearTimeout(timer); return true;
  }});
  void prepareMemorySnapshot().then(() => render()).catch(e => toast(e.message));
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
    const pre = node('pre', text, 'context-preview context-scroll');
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
async function render() {
  const dialog = document.querySelector('#context-viewer .sheet');
  if (!dialog || !open) return;
  const run = ++version, live = memorySnapshot();
  if (viewedSession !== state.sessionId) {
    viewedSession = state.sessionId;
    expanded.clear(); scrollPositions.clear();
    dialog.querySelector('.memory-content')?.remove();
  }
  if (!live) {
    dialog.querySelector('.memory-content')?.remove();
    dialog.append(node('p', 'Open a story to see its context.', 'memory-content muted'));
    return;
  }
  try {
    const draftText = document.getElementById('chat-input').value;
    const built = await buildContextForRequest(live.session, effectiveActiveSettings(), {
      messages:live.messages, loreEntries:live.entries, draftText, includeInspection:true,
    });
    if (run !== version || !open || state.sessionId !== live.session.id) return;
    rememberView();
    const focusKey = document.activeElement?.dataset?.focusKey;
    const body = node('div', null, 'memory-content context-content');
    const r = built.report, sections = built.inspection.sections;
    const mem = normalizeMemory(live.session.memory);
    const overview = node('section', null, 'context-overview');
    const heading = node('div', null, 'context-overview-heading');
    const refresh = button('Refresh', async () => { await prepareMemorySnapshot(); void render(); });
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
    if (draftText.trim()) overview.append(node('p', 'including your draft', 'muted'));
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
        card.append(node('p', included ? `Loaded · ${e.reason} · ${e.tokens.toLocaleString()} tokens within this book${e.linesCut ? ' · '+e.linesCut+' older lines not sent' : ''}${e.draft ? ' · draft' : ''}` : e.reason==='no card' ? 'In scene, no card' : 'Not loaded — '+e.reason, 'muted'));
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
    body.append(lore);
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
    if (run !== version || !open || state.sessionId!==live.session.id) return;
    const body = node('div', null, 'memory-content');
    body.append(node('p', e.message, 'memory-warning'), button('Refresh', () => render()));
    dialog.querySelector('.memory-content')?.remove(); dialog.append(body);
  }
}
function closeViewer() { document.querySelector('#context-viewer .settings-close')?.click(); }
