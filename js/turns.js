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
function prepareEligibility(messages, memoryState, mem) {
  const turns=computeTurns(messages),byId=new Map();
  // Preserve Array.find's first-ID behavior, including damaged duplicate input.
  for(const message of messages)if(!byId.has(message.id))byId.set(message.id,message);
  const eligible=turns.assistants.slice(0,Math.max(0,turns.assistants.length-mem.lagTurns)).filter(a=>a.order>memoryState.extractedThroughOrder);
  const lastUserOrder=lastUserOrderOf(messages);
  const blocked=eligible.findIndex(a=>!isAcceptedTurn(byId.get(a.id),{lastUserOrder,sceneOn:mem.scene}));
  return {turns,eligible,blocked};
}
function rangeFromEligibility(messages,mem,{turns,eligible,blocked},{manual=false}={}) {
  if(blocked>=0)eligible=eligible.slice(0,blocked);
  if (eligible.length < (manual ? 1 : mem.batchTurns)) return null;
  const chosen = eligible.slice(0, mem.batchTurns), end = chosen.at(-1);
  const chosenTurns = new Set(chosen.map(a => a.turn));
  return { messages:messages.filter(m => m.role !== 'summary' && chosenTurns.has(turns.turnById.get(m.id))), fromTurn: chosen[0].turn, toTurn: end.turn, endOrder: end.order, assistants: chosen, turns };
}
export function dueRange(messages, memoryState, mem, opts = {}) {
  const pointer = memoryState?.extractedThroughOrder;
  if (pointer == null) return null;
  return rangeFromEligibility(messages,mem,prepareEligibility(messages,memoryState,mem),opts);
}
// The upcoming reply counts toward scheduling, but only existing completed
// turns can enter the batch. Its success is not required to save that batch.
export function alongsideTurnRange(messages, memoryState, mem) {
  const latest = messages.filter(m => m.role !== 'summary').sort((a,b) => a.order-b.order).at(-1);
  if (latest?.role !== 'user') return null;
  const range = dueRange(messages,memoryState,{...mem,lagTurns:Math.max(0,mem.lagTurns-1)});
  return range ? {...range,messages:range.messages.filter(m=>m.order<=range.endOrder)} : null;
}
// Eligibility only: callers handle automatic-update settings and paused/running state.
export function memoryUpdateTiming(messages, memoryState, mem, {status}={}) {
  if (memoryState?.extractedThroughOrder == null) return null;
  if ((status ?? dueRangeStatus(messages,memoryState,mem)).range) return 'due';
  const order = messages.reduce((max,m) => Math.max(max,m.order),0);
  const turn = computeTurns(messages).lastTurn+1;
  // A later user input also accepts earlier reviewable replies, just as Send does.
  // Symbols keep these temporary IDs distinct from every saved message ID.
  const upcoming = [...messages,{ id:Symbol('next-user'),role:'user',order:order+1,narratorTurn:turn }];
  if (alongsideTurnRange(upcoming,memoryState,mem)) return 'with-next-turn';
  const projected = [...upcoming,
    { id:Symbol('next-reply'),role:'assistant',order:order+2,narratorTurn:turn,acceptance:'accepted' },
  ];
  return dueRange(projected,memoryState,mem) ? 'next-turn' : null;
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
  const prepared=prepareEligibility(messages,ms,mem),{eligible,blocked}=prepared;
  const pending=blocked<0 ? null : eligible[blocked];
  const range=rangeFromEligibility(messages,mem,prepared,opts);
  if(range)return {range};
  return pending ? {reason:'pending',turn:pending.turn} : {reason:'waiting',have:eligible.length,need:opts.manual?1:mem.batchTurns,lag:mem.lagTurns};
}
