import {computeTurns} from './turns.js';
import {normalizeMemory} from './memory-settings.js';
export function rebuildLabel(snapshot) {
  const order=snapshot?.session.memoryState?.rebuildFromOrder;
  const turns=computeTurns(snapshot?.messages ?? []),mem=normalizeMemory(snapshot?.session.memory);
  const first=turns.turnById.get(snapshot?.messages.find(m=>m.order===order)?.id) ?? '?';
  const eligible=turns.assistants.slice(0,Math.max(0,turns.assistants.length-mem.lagTurns)).filter(a=>a.order>=order);
  return `History edited at T${first} — re-extract ${eligible.length} turns (~${Math.ceil(eligible.length/mem.batchTurns)} extraction calls)`;
}
