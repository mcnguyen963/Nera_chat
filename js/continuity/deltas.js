import { object, list, string, text, id, RECORD_DATA, RECORD_SCHEMA, validate } from "./schema.js";
import { sourceRef } from "./state.js";

const source = { type: "string", enum: ["input", "narration"] };
const proof = { source, evidence: string(8000) };
const defaults = {
  character: { aliases: [], controller: "narrator", personality: "", background: "", voice: "", emotion: "", condition: "", goals: [], intentions: [] },
  relationship: { trust: "", affection: "", hostility: "", boundaries: [] },
  belief: { stance: "unknown", acquisition: "" },
  consequence: { status: "open" },
  scene: { location: "", storyTime: "", present: [], pending: [] },
  agenda: { participants: [], prerequisites: [], opportunity: "", status: "available", origin: "narrator" },
  world_fact: { entityIds: [], visibility: "restricted" },
};
const required = { character: ["name"], relationship: ["from", "to"], belief: ["holder", "proposition"],
  consequence: ["holder", "target", "category", "description"], scene: [], agenda: ["direction"], world_fact: ["proposition"] };
const edit = object({ target: id, action: { type: "string", enum: ["set", "add", "remove", "append"] },
  field: string(100), value: { anyOf: [text, list(string())] }, ...proof });
const create = Object.entries(RECORD_DATA).map(([kind, data]) => object({ target: id, action: { const: "create" },
  kind: { const: kind }, data: { ...data, required: required[kind] }, ...proof }));
const remember = object({ action: { const: "remember" }, description: string(), characters: list(id), ...proof });
export const DELTA_OUTPUT_SCHEMA = object({ narration: string(50000), changes: list({ anyOf: [edit, ...create, remember] }) });

export function equalData(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalData(a[key], b[key]));
}

// Only a complete outer JSON fence is safely removable. Never guess missing values.
export function parseStateOutput(content) {
  if (typeof content !== "string") throw new Error("Final content is not text.");
  // Some reasoning providers expose a completed thinking block in content.
  // Discard only a fully closed leading block; never guess at incomplete output.
  const trimmed = content.trim().replace(/^(?:<think>[\s\S]*?<\/think>\s*)+/i, "").trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export function applyFieldChange(data, change) {
  if (!Object.hasOwn(data, change.field)) throw new Error(`Unknown record field: ${change.field}`);
  const previous = data[change.field];
  if (change.action === "set") data[change.field] = structuredClone(change.value);
  else if (change.action === "add" || change.action === "remove") {
    if (!Array.isArray(previous) || typeof change.value !== "string" || !change.value.trim())
      throw new Error("add/remove requires an array field and one nonempty string item.");
    if (change.action === "add") { if (!previous.includes(change.value)) previous.push(change.value); }
    else data[change.field] = previous.filter((item) => item !== change.value);
  } else if (change.action === "append") {
    if (typeof previous !== "string" || typeof change.value !== "string" || !change.value.trim())
      throw new Error("append requires a text field and nonempty new text.");
    if (previous !== change.value && !previous.split("\n").includes(change.value))
      data[change.field] = previous ? `${previous}\n${change.value}` : change.value;
  } else throw new Error("Unknown state change action.");
}

const references = { relationship: ["from", "to"], belief: ["holder"], consequence: ["holder", "target"],
  scene: ["present"], agenda: ["participants"], world_fact: ["entityIds"] };
function mapData(kind, data, aliases) {
  const mapped = structuredClone(data);
  for (const field of references[kind] ?? []) {
    if (!Object.hasOwn(mapped, field)) continue;
    mapped[field] = Array.isArray(mapped[field]) ? mapped[field].map((value) => aliases.get(value) ?? value)
      : aliases.get(mapped[field]) ?? mapped[field];
  }
  return mapped;
}
function characterRefs(record, characters) {
  if (record.kind === "character") return [record.id];
  return (references[record.kind] ?? []).flatMap((field) => {
    const value = record.data[field];
    return Array.isArray(value) ? value : [value];
  }).filter((value) => characters.has(value));
}

export function expandDeltaProposal(output, state, turnId, user, assistant) {
  validate(DELTA_OUTPUT_SCHEMA, output);
  if (output.narration !== assistant.content) throw new Error("State proposal does not match saved narration.");
  const aliases = new Map();
  output.changes.forEach((change, index) => {
    if (change.action !== "create") return;
    if (aliases.has(change.target) || state.records.some((record) => record.id === change.target))
      throw new Error("New record labels must be unique and must not replace existing records.");
    const generated = `${turnId.slice(0, 75)}_record_${index}`;
    if (state.records.some((record) => record.id === generated)) throw new Error("Generated record ID already exists.");
    aliases.set(change.target, generated);
  });
  const originals = new Map(state.records.map((record) => [record.id, record]));
  const records = new Map();
  const supports = new Map();
  const events = [];
  const characters = new Set(state.records.filter((record) => record.kind === "character").map((record) => record.id));
  // Pre-create records so references to another newly introduced character can be resolved.
  output.changes.forEach((change) => {
    if (change.action !== "create") return;
    const recordId = aliases.get(change.target);
    const data = mapData(change.kind, { ...structuredClone(defaults[change.kind]), ...change.data }, aliases);
    if (change.kind === "agenda") {
      if (change.source === "input" && user.role === "author") data.origin = "author";
      else if (data.origin === "author") throw new Error("An author direction requires current explicit author input.");
    }
    const record = { id: recordId, kind: change.kind, data };
    validate(RECORD_SCHEMA, record);
    records.set(recordId, record);
    if (change.kind === "character") characters.add(recordId);
  });
  output.changes.forEach((change, index) => {
    const message = change.source === "input" ? user : assistant;
    if (message.role === "user" && change.action !== "remember") {
      const target = aliases.get(change.target) ?? change.target;
      const prior = records.get(target) ?? originals.get(target);
      const playerField = prior?.kind === "character" && prior.data.controller === "player" &&
        change.action !== "create" && ["emotion", "goals", "intentions"].includes(change.field);
      const playerCreation = change.action === "create" && change.kind === "character" && prior?.data.controller === "player";
      if (!playerField && !playerCreation)
        throw new Error("A player message cannot establish an NPC reaction or contested outcome; use resolved narration.");
    }
    if (!message.content.includes(change.evidence)) throw new Error("State evidence is absent from its source. Use an exact excerpt.");
    let record;
    if (change.action !== "remember") {
      const target = aliases.get(change.target) ?? change.target;
      const old = originals.get(target);
      record = records.get(target) ?? (old ? { id: old.id, kind: old.kind, data: structuredClone(old.data) } : null);
      if (!record) throw new Error(`Unknown state target: ${change.target}`);
      if (change.action !== "create") {
        const previous = structuredClone(record.data);
        const mappedValue = mapData(record.kind, { [change.field]: change.value }, aliases)[change.field];
        applyFieldChange(record.data, { ...change, value: mappedValue });
        validate(RECORD_SCHEMA, record);
        if (equalData(previous, record.data)) return;
        if (old?.kind === "character" && ["name", "aliases", "controller", "personality", "background", "voice"].includes(change.field) && message.role !== "author")
          throw new Error("Baseline changes require the current explicit author input for that change.");
        if (record.kind === "character" && record.data.controller === "player" && ["emotion", "goals", "intentions"].includes(change.field) && !["user", "author"].includes(message.role))
          throw new Error("Player inner state requires player evidence for that change.");
        if (old?.kind === "agenda" && old.data.origin === "author" && ["direction", "origin"].includes(change.field) && message.role !== "author")
          throw new Error("The narrator cannot replace an author direction.");
      }
      records.set(target, record);
    }
    const entities = record ? characterRefs(record, characters) : change.characters.map((value) => aliases.get(value) ?? value);
    if (entities.some((value) => !characters.has(value))) throw new Error("Historical memory references an unknown character.");
    const kind = message.role === "author" ? (record && originals.has(record.id) ? "author_correction" : "author_setup")
      : message.role === "user" ? "report" : record?.kind === "belief" && record.data.stance === "knows" ? "observation" : "outcome";
    const event = { id: `${turnId.slice(0, 75)}_event_${index}`, kind,
      description: change.action === "remember" ? change.description : change.evidence,
      entityIds: [...new Set(entities)], sources: [sourceRef(message, change.evidence)], supersedes: [] };
    events.push(event);
    if (record) supports.set(record.id, [...(supports.get(record.id) ?? []), event]);
  });
  for (const event of events) {
    const belief = [...records.values()].find((record) => record.kind === "belief" &&
      record.data.stance === "knows" && (supports.get(record.id) ?? []).includes(event));
    if (belief && event.sources[0].messageId === assistant.id) event.kind = "observation";
  }
  const operations = [...records.values()].filter((record) => !equalData(originals.get(record.id)?.data, record.data)).map((record) => {
    const evidence = supports.get(record.id) ?? [];
    if (!evidence.length) throw new Error("Changed record has no supporting evidence.");
    // Each supporting event covers the final record's character references.
    const entityIds = characterRefs(record, characters);
    evidence.forEach((event) => { event.entityIds = [...new Set([...event.entityIds, ...entityIds])]; });
    return { type: "put_record", record, expectedVersion: originals.get(record.id)?.version ?? 0,
      reason: "Supported change from the current turn.", eventIds: evidence.map((event) => event.id),
      sources: [...new Map(evidence.flatMap((event) => event.sources).map((source) => [source.messageId, source])).values()] };
  });
  return { branchId: state.branchId, baseRevision: state.revision, turnId, events, operations };
}
