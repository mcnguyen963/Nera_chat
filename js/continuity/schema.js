// Shared by API tool schemas, the reviewer, and local validation. No provider SDK.
export const string = (maxLength = 4000) => ({ type: "string", minLength: 1, maxLength });
export const text = { type: "string", maxLength: 8000 };
export const id = { ...string(100), pattern: "^[A-Za-z0-9_-]+$" };
export const integer = { type: "integer", minimum: 0 };
export const list = (items, maxItems = 50) => ({ type: "array", items, maxItems });
export const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const choice = (...values) => ({ type: "string", enum: values });

export const SOURCE_SCHEMA = object({ messageId: id, revision: integer,
  contentHash: string(64), quote: string(8000) });
export const EVENT_SCHEMA = object({ id, kind: choice("outcome", "observation", "report", "author_setup", "author_correction"),
  description: string(), entityIds: list(id), sources: { ...list(SOURCE_SCHEMA, 10), minItems: 1 }, supersedes: list(id) });

export const RECORD_DATA = {
  character: object({ name: string(200), aliases: list(string(200)), controller: choice("player", "narrator"),
    personality: text, background: text, voice: text, emotion: text, condition: text,
    goals: list(string()), intentions: list(string()) }),
  relationship: object({ from: id, to: id, trust: text, affection: text, hostility: text, boundaries: list(string()) }),
  belief: object({ holder: id, proposition: string(), stance: choice("knows", "believes", "suspects", "denies", "unknown"), acquisition: text }),
  consequence: object({ holder: id, target: id, category: choice("grievance", "promise", "loyalty", "conflict", "injury", "debt"),
    description: string(), status: choice("open", "resolved") }),
  scene: object({ location: text, storyTime: text, present: list(id), pending: list(string()) }),
  agenda: object({ direction: string(), participants: list(id), prerequisites: list(string()),
    opportunity: text, status: choice("available", "blocked", "deferred", "completed", "abandoned"), origin: choice("author", "narrator") }),
  world_fact: object({ proposition: string(), entityIds: list(id), visibility: choice("public", "restricted") }),
};

export const RECORD_SCHEMA = { anyOf: Object.entries(RECORD_DATA).map(([kind, data]) =>
  object({ id, kind: { const: kind }, data })) };
export const OPERATION_SCHEMA = object({ type: { const: "put_record" }, record: RECORD_SCHEMA,
  expectedVersion: integer, reason: string(), eventIds: { ...list(id), minItems: 1 },
  sources: { ...list(SOURCE_SCHEMA, 10), minItems: 1 } });
// Normal turns remain small; a one-time migration can establish substantially
// more records. The reducer accepts either bounded shape for branch replay.
const patchSchema = (maxItems) => object({ branchId: id, baseRevision: integer, turnId: id,
  events: list(EVENT_SCHEMA, maxItems), operations: list(OPERATION_SCHEMA, maxItems) });
export const PATCH_SCHEMA = patchSchema(500);
export const REVIEW_SCHEMA = object({ verdict: choice("accept", "reject"),
  violations: list(string()), patch: patchSchema(50) });
export const MIGRATION_REVIEW_SCHEMA = object({ verdict: choice("accept", "reject"),
  violations: list(string()), patch: PATCH_SCHEMA });

// Deliberately limited to the JSON Schema vocabulary emitted above. Unknown
// provider output must pass the same checks even without structured outputs.
export function validate(schema, value, path = "value") {
  const fail = (message) => { throw new Error(`${path}: ${message}`); };
  if (schema.anyOf) {
    for (const variant of schema.anyOf) {
      try { validate(variant, value, path); return value; } catch { /* Try the next record type. */ }
    }
    fail("does not match an allowed record schema");
  }
  if ("const" in schema && value !== schema.const) fail("unexpected value");
  if (schema.enum && !schema.enum.includes(value)) fail("unexpected enum value");
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected object");
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`unknown field ${key}`);
      validate(schema.properties[key], item, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail("expected array");
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail("array length out of bounds");
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
  } else if (schema.type === "string") {
    if (typeof value !== "string") fail("expected string");
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) fail("string length out of bounds");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail("invalid identifier");
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? 0)) fail("expected nonnegative integer");
  }
  return value;
}
