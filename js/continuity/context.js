import { countTokens } from "../tokenizer.js";
import { activeEvents, assertUsableState } from "./state.js";
import { NARRATOR_CONTRACT, TOOL_POLICY } from "./prompts.js";

export function selectContinuity(state, input, explicitIds = []) {
  assertUsableState(state);
  const characters = state.records.filter((r) => r.kind === "character");
  const scene = state.records.find((r) => r.kind === "scene");
  const active = new Set([...explicitIds, ...(scene?.data.present ?? []),
    ...characters.filter((r) => r.data.controller === "player").map((r) => r.id)]);
  const words = new Set(input.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  for (const character of characters) {
    if ([character.id, character.data.name, ...character.data.aliases].some((alias) =>
      alias.trim() && (alias.includes(" ") ? input.toLocaleLowerCase().includes(alias.toLocaleLowerCase()) : words.has(alias.toLocaleLowerCase()))))
      active.add(character.id);
  }
  if ([...active].some((ref) => !characters.some((r) => r.id === ref))) throw new Error("Scene references an unknown character.");
  const relevant = (record) => {
    const d = record.data;
    if (record.kind === "character") return active.has(record.id);
    if (record.kind === "scene") return true;
    if (record.kind === "relationship") return active.has(d.from) || active.has(d.to);
    if (record.kind === "belief" || record.kind === "consequence") return active.has(d.holder);
    if (record.kind === "world_fact") return !d.entityIds.length || d.entityIds.some((ref) => active.has(ref));
    return false;
  };
  const records = state.records.filter(relevant);
  const eventIds = new Set(records.flatMap((r) => r.eventIds));
  const futurePossibilities = state.records.filter((r) => r.kind === "agenda" &&
    ["available", "blocked"].includes(r.data.status) && (!r.data.participants.length || r.data.participants.some((ref) => active.has(ref))));
  return { activeCharacterIds: [...active], records,
    events: activeEvents(state).filter((event) => eventIds.has(event.id)), futurePossibilities,
    focus: futurePossibilities.map((r) => ({ agendaId: r.id, direction: r.data.direction, status: r.data.status,
      prerequisites: r.data.prerequisites, occurred: false })) };
}

export async function requestTokenCount(messages, tools = [], count = countTokens) {
  const costs = await Promise.all(messages.map(async (m) =>
    8 + await count(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")) +
    (m.tool_calls ? await count(JSON.stringify(m.tool_calls)) : 0) + (m.tool_call_id ? await count(m.tool_call_id) : 0)));
  return 3 + costs.reduce((a, b) => a + b, 0) + (tools.length ? await count(JSON.stringify(tools)) : 0);
}

export function inputBudget(settings) {
  const max = Math.min(settings.maxContextTokens, settings.modelContextTokens ?? Infinity);
  const reserve = settings.maxResponseTokens;
  if (!Number.isSafeInteger(max) || !Number.isSafeInteger(reserve) || reserve < 1 || max <= reserve)
    throw new Error("Invalid context or completion budget.");
  return max - reserve - Math.max(128, Math.ceil(max * 0.05));
}

export async function buildContinuityContext({ state, messages, input, mode = "player", characterIds = [],
  settings, stylePrompt = "", tools = [], recentExchanges = 8, count = countTokens, upToOrder = Infinity }) {
  if (state.throughOrder >= upToOrder) throw new Error("Historical generation requires a state snapshot before the target. Fork first.");
  if (!["player", "author"].includes(mode) || typeof input !== "string" || !input.trim()) throw new Error("Invalid current input.");
  const recentCues = messages.filter((m) => ["user", "author", "assistant"].includes(m.role) &&
      m.order <= state.throughOrder && m.order < upToOrder)
    .sort((a, b) => a.order - b.order).slice(-2).map((m) => m.content).join("\n");
  const selected = selectContinuity(state, `${input}\n${recentCues}`, characterIds);
  const system = { role: "system", content: `${NARRATOR_CONTRACT}\n\n${TOOL_POLICY}` };
  const current = { role: "user", content: JSON.stringify({ type: "current_turn", branchId: state.branchId,
    stateRevision: state.revision, mode, state: { records: selected.records, events: selected.events },
    stylePreferences: stylePrompt || "", playerInput: input }) };
  const budget = inputBudget(settings);
  let apiMessages = [system, current];
  let usedTokens = await requestTokenCount(apiMessages, tools, count);
  if (usedTokens > budget) throw new Error("The current input and essential character state exceed the context budget. Increase the budget or shorten the input.");
  const reference = { role: "user", content: JSON.stringify({ type: "application_reference",
    futurePossibilities: selected.futurePossibilities, focus: selected.focus }) };
  if (selected.futurePossibilities.length && await requestTokenCount([system, reference, current], tools, count) <= budget)
    apiMessages.splice(1, 0, reference);
  // Accepted exchanges are kept whole, newest first during budget selection.
  const history = messages.filter((m) => ["user", "author", "assistant"].includes(m.role) && m.order <= state.throughOrder && m.order < upToOrder)
    .sort((a, b) => a.order - b.order);
  const exchanges = [];
  let pending = [];
  for (const message of history) {
    pending.push(message);
    if (message.role === "assistant") { exchanges.push(pending); pending = []; }
  }
  const included = [];
  for (const exchange of exchanges.slice(-recentExchanges).reverse()) {
    const entries = exchange.map((m) => ({ role: m.role === "author" ? "user" : m.role,
      content: m.role === "author" ? JSON.stringify({ type: "author_note", content: m.content }) : m.content }));
    const candidate = [...apiMessages.slice(0, -1), ...entries, ...included, current];
    if (await requestTokenCount(candidate, tools, count) > budget) break;
    included.unshift(...entries);
  }
  apiMessages = [...apiMessages.slice(0, -1), ...included, current];
  usedTokens = await requestTokenCount(apiMessages, tools, count);
  return { apiMessages, usedTokens, budget, selection: selected,
    trace: { branchId: state.branchId, revision: state.revision, recordIds: selected.records.map((r) => r.id),
      eventIds: selected.events.map((e) => e.id), historyMessages: included.length, droppedMessages: history.length - included.length } };
}
