import { PATCH_SCHEMA, RECORD_SCHEMA, EVENT_SCHEMA, validate, id } from "./schema.js";

export function createStoryState(branchId = "main") {
  validate(id, branchId);
  return { schemaVersion: 1, branchId, revision: 0, throughOrder: 0, records: [], events: [] };
}

export async function sourceMessage({ id: messageId, revision = 1, role, content, order = 0 }) {
  validate(id, messageId);
  if (!["user", "assistant", "author"].includes(role) || typeof content !== "string" || !content.trim())
    throw new Error("Invalid continuity source message.");
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(order) || order < 0)
    throw new Error("Invalid source revision or order.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id: messageId, revision, role, content, order, contentHash };
}

export function sourceRef(message, quote = message.content) {
  return { messageId: message.id, revision: message.revision, contentHash: message.contentHash, quote };
}

function checkSources(refs, messages) {
  for (const ref of refs) {
    const message = messages.find((m) => m.id === ref.messageId && m.revision === ref.revision);
    if (!message || message.contentHash !== ref.contentHash || !message.content.includes(ref.quote))
      throw new Error(`Unverifiable source: ${ref.messageId}`);
  }
}

export function verifyStateSources(state, messages) {
  assertUsableState(state);
  for (const event of state.events) checkSources(event.sources, messages);
  for (const record of state.records) checkSources(record.sources, messages);
  return state;
}

const currentEvidence = (sources, messages, role, order) => sources.some((ref) =>
  messages.some((m) => m.id === ref.messageId && m.revision === ref.revision &&
    m.role === role && m.order === order));

export function activeEvents(state) {
  const superseded = new Set(state.events.flatMap((event) => event.supersedes));
  return state.events.filter((event) => !superseded.has(event.id));
}

export function assertUsableState(state) {
  if (state.schemaVersion !== 1) throw new Error("Unsupported continuity version.");
  validate(id, state.branchId);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isSafeInteger(state.throughOrder) || state.throughOrder < 0)
    throw new Error("Invalid continuity revision.");
  for (const key of ["records", "events"]) {
    if (!Array.isArray(state[key]) || new Set(state[key].map((item) => item.id)).size !== state[key].length)
      throw new Error(`Duplicate or invalid ${key}.`);
  }
  const events = new Set(activeEvents(state).map((event) => event.id));
  state.events.forEach(({ sequence, ...event }) => validate(EVENT_SCHEMA, event));
  for (const record of state.records) {
    validate(RECORD_SCHEMA, { id: record.id, kind: record.kind, data: record.data });
    if (!Number.isSafeInteger(record.version) || record.version < 1 || !Array.isArray(record.eventIds) ||
        !record.eventIds.length || record.eventIds.some((eventId) => !events.has(eventId)))
      throw new Error(`State needs rebuilding: ${record.id}`);
  }
  const characters = new Set(state.records.filter((r) => r.kind === "character").map((r) => r.id));
  if (state.records.filter((r) => r.kind === "scene").length > 1) throw new Error("Only one current scene is allowed.");
  for (const record of state.records) {
    const d = record.data;
    const refs = record.kind === "relationship" ? [d.from, d.to]
      : record.kind === "belief" ? [d.holder]
      : record.kind === "consequence" ? [d.holder, d.target]
      : record.kind === "scene" ? d.present
      : record.kind === "agenda" ? d.participants : [];
    if (refs.some((ref) => !characters.has(ref))) throw new Error(`Unknown character in ${record.id}`);
  }
  return state;
}

// Pure reducer. Absence from a patch means unchanged, including old grievances.
// Source checks validate provenance, not semantic entailment; the reviewer is
// responsible for judging whether a quoted development justifies the change.
export function applyContinuityPatch(state, patch, { messages, throughOrder }) {
  assertUsableState(state);
  validate(PATCH_SCHEMA, patch);
  if (patch.branchId !== state.branchId || patch.baseRevision !== state.revision)
    throw new Error("Stale continuity revision or wrong branch.");
  if (!Number.isSafeInteger(throughOrder) || throughOrder < state.throughOrder ||
      (throughOrder === state.throughOrder && state.revision !== 0))
    throw new Error("Cannot apply a turn to an earlier state. Fork first.");
  const inputOrder = throughOrder === 0 ? 0 : throughOrder - 1;
  const next = structuredClone(state);
  const newIds = new Set();
  for (const event of patch.events) {
    if (newIds.has(event.id) || next.events.some((item) => item.id === event.id)) throw new Error("Duplicate event ID.");
    checkSources(event.sources, messages);
    if (["author_setup", "author_correction"].includes(event.kind) &&
        !currentEvidence(event.sources, messages, "author", inputOrder))
      throw new Error("An author event requires the current explicit author input.");
    if (["outcome", "observation"].includes(event.kind) &&
        !event.sources.some((ref) => messages.some((m) => m.id === ref.messageId && m.revision === ref.revision &&
          ["assistant", "author"].includes(m.role))))
      throw new Error("An outcome or observation requires established narration or author evidence.");
    if (event.supersedes.length && (event.kind !== "author_correction" || event.supersedes.some((ref) => !state.events.some((e) => e.id === ref))))
      throw new Error("Only an explicit correction can supersede an existing event.");
    next.events.push({ ...structuredClone(event), sequence: state.revision + 1 });
    newIds.add(event.id);
  }
  const liveEvents = activeEvents(next);
  const changed = new Set();
  for (const op of patch.operations) {
    const incoming = op.record;
    if (changed.has(incoming.id)) throw new Error("A record can only be changed once per patch.");
    changed.add(incoming.id);
    const old = next.records.find((record) => record.id === incoming.id);
    if ((old?.version ?? 0) !== op.expectedVersion || (old && old.kind !== incoming.kind))
      throw new Error(`Stale record version: ${incoming.id}`);
    checkSources(op.sources, messages);
    if (op.eventIds.some((ref) => !liveEvents.some((event) => event.id === ref))) throw new Error("Missing or superseded event evidence.");
    if (!op.eventIds.some((ref) => newIds.has(ref))) throw new Error("A state change requires new event evidence.");
    if (op.eventIds.some((eventId) => {
      const event = liveEvents.find((item) => item.id === eventId);
      const entities = [incoming.id,
        ...(incoming.kind === "relationship" ? [incoming.data.from, incoming.data.to] : []),
        ...(incoming.kind === "belief" ? [incoming.data.holder] : []),
        ...(incoming.kind === "consequence" ? [incoming.data.holder, incoming.data.target] : [])];
      if (incoming.kind === "character" && !state.records.some((record) => record.kind === "character" && record.id === incoming.id))
        entities.push(incoming.id);
      return entities.some((entityId) => (state.records.some((record) => record.kind === "character" && record.id === entityId) ||
        (incoming.kind === "character" && incoming.id === entityId)) && !event.entityIds.includes(entityId));
    })) throw new Error("Event evidence does not identify every character in " + incoming.id);
    const isAuthor = currentEvidence(op.sources, messages, "author", inputOrder);
    if (old?.kind === "character") {
      const baseline = ["name", "aliases", "controller", "personality", "background", "voice"];
      if (!isAuthor && baseline.some((key) => JSON.stringify(old.data[key]) !== JSON.stringify(incoming.data[key])))
        throw new Error("Baseline changes require an explicit author correction.");
    }
    if (incoming.kind === "character" && incoming.data.controller === "player") {
      const voluntary = ["emotion", "goals", "intentions"];
      if (!isAuthor && voluntary.some((key) => JSON.stringify(old?.data[key] ?? (key === "emotion" ? "" : [])) !== JSON.stringify(incoming.data[key])) &&
          !currentEvidence(op.sources, messages, "user", inputOrder))
        throw new Error("Player inner state requires player evidence.");
    }
    if (incoming.kind === "belief" && incoming.data.stance === "knows") {
      if (!incoming.data.acquisition.trim() || !op.eventIds.some((ref) => liveEvents.some((e) => e.id === ref &&
          ["observation", "author_setup", "author_correction"].includes(e.kind) && e.entityIds.includes(incoming.data.holder))))
        throw new Error("Knowledge requires an acquisition event for this character.");
    }
    if (old?.kind === "agenda" && old.data.origin === "author" && !isAuthor &&
        (incoming.data.direction !== old.data.direction || incoming.data.origin !== "author"))
      throw new Error("The narrator cannot replace an author direction.");
    const record = { ...structuredClone(incoming), version: op.expectedVersion + 1,
      eventIds: [...op.eventIds], sources: structuredClone(op.sources) };
    if (old) next.records[next.records.indexOf(old)] = record;
    else next.records.push(record);
  }
  next.revision++;
  next.throughOrder = throughOrder;
  return assertUsableState(next);
}
