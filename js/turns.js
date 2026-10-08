import { sceneTimeline } from './scene.js';
import { readSceneOutput } from './scene-parser.js';
import { isAcceptedTurn, lastUserOrderOf } from './turn-review.js';
// Persisted narratorTurn is authoritative; legacy fallback is migrated before mutations.
export function computeTurns(messages) {
  const raw = [...messages].filter(m => m.role !== 'summary').sort((a,b) => a.order-b.order);
  const followingTurn = [], turnById = new Map(), assistants = [], starts = new Map();
  let following = null;
  for (let i=raw.length-1;i>=0;i--) {
    if (raw[i].role === 'assistant') following = raw[i].narratorTurn ?? null;
    followingTurn[i] = following;
  }
  let next = 1;
  for (const [i,m] of raw.entries()) {
    const turn = m.narratorTurn ?? followingTurn[i] ?? next;
    turnById.set(m.id,turn); if (!starts.has(turn)) starts.set(turn,m.order);
    if (m.role === 'assistant') { assistants.push({ id:m.id,order:m.order,turn,startOrder:starts.get(turn) }); next = Math.max(next,turn+1); }
  }
  const trailing = raw.filter(m => m.order > (assistants.at(-1)?.order ?? 0));
  return { turnById,assistants,lastTurn:assistants.at(-1)?.turn ?? 0,trailingStartOrder:trailing[0]?.order ?? null };
}
export function turnStartOrder(turns, t) { return turns.assistants.find(a => a.turn === t)?.startOrder ?? (t === turns.lastTurn+1 ? turns.trailingStartOrder : null); }
export function assistantOrderOfTurn(turns, t) { return turns.assistants.find(a => a.turn === t)?.order ?? null; }
export function dueRange(messages, memoryState, mem, { manual = false } = {}) {
  const pointer = memoryState?.extractedThroughOrder;
  if (pointer == null) return null;
  const turns = computeTurns(messages);
  let eligible = turns.assistants.slice(0, Math.max(0, turns.assistants.length-mem.lagTurns)).filter(a => a.order > pointer);
  const lastUserOrder=lastUserOrderOf(messages);
  const blocked = eligible.findIndex(a => !isAcceptedTurn(messages.find(m => m.id === a.id),{lastUserOrder,sceneOn:mem.scene}));
  if (blocked >= 0) eligible = eligible.slice(0,blocked);
  if (eligible.length < (manual ? 1 : mem.batchTurns)) return null;
  const chosen = eligible.slice(0, mem.batchTurns), end = chosen.at(-1);
  const chosenTurns = new Set(chosen.map(a => a.turn));
  return { messages:messages.filter(m => m.role !== 'summary' && chosenTurns.has(turns.turnById.get(m.id))), fromTurn: chosen[0].turn, toTurn: end.turn, endOrder: end.order, assistants: chosen, turns };
}
export function formatTurnsTranscript(messages, turns = computeTurns(messages), { range, protagonist = '', title } = {}) {
  const lines = title ? [`# ${title} — transcript for lorebook generation`, `# Protagonist: ${protagonist || 'the main character'}`, '# Turn N = stable narrator turn; deleted turns keep their numbers. User messages belong to the following reply.', ''] : [];
  const timeline=sceneTimeline(messages);
  let previous = null;
  for (const m of [...(range?.messages ?? messages)].filter(m => m.role !== 'summary').sort((a,b) => a.order-b.order)) {
    const t = turns.turnById.get(m.id);
    if (t !== previous) {
      const assistant = messages.find(x => x.id === turns.assistants.find(a => a.turn === t)?.id);
      lines.push(`=== Turn ${t}${timeline.get(assistant?.id)?.own ? ' · '+timeline.get(assistant.id).own : ''} ===`); previous = t;
    }
    let content = m.role === 'assistant' ? readSceneOutput(m.content).clean : String(m.content ?? '');
    const notes = [];
    if (m.role === 'user') content = content.replace(/<ad>([\s\S]*?)(?:<\/ad>|<ad>|$)/gi, (_, note) => { notes.push(note.trim()); return ''; });
    if (content.trim()) lines.push(`${m.role === 'user' ? 'USER' : 'STORY'}: ${content.trim()}`);
    for (const note of notes) lines.push('AUTHOR NOTE: '+note);
  }
  return lines.join('\n\n');
}

export function dueRangeStatus(messages,ms,mem,opts={}) {
  if(ms?.extractedThroughOrder==null)return {reason:'pointer-unset'};
  const turns=computeTurns(messages),eligible=turns.assistants.slice(0,Math.max(0,turns.assistants.length-mem.lagTurns)).filter(a=>a.order>ms.extractedThroughOrder);
  const pending=eligible.find(a=>!isAcceptedTurn(messages.find(m=>m.id===a.id),{lastUserOrder:lastUserOrderOf(messages),sceneOn:mem.scene}));
  const range=dueRange(messages,ms,mem,opts);
  if(range)return {range};
  return pending ? {reason:'pending',turn:pending.turn} : {reason:'waiting',have:eligible.length,need:opts.manual?1:mem.batchTurns,lag:mem.lagTurns};
}
