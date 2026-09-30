import { test } from "node:test";
import assert from "node:assert/strict";
import { packRecordChunks, unpackRecordChunks, RECORD_CHUNK_BYTES } from "../js/continuity/record-chunks.js";

const records = (n) => Array.from({ length: n }, (_, i) => ({ id: `char_${String(i).padStart(4, "0")}`, data: { name: `Character ${i}` } }));

test("many character records share bounded chunks and round trip without duplicates", () => {
  const values = records(205);
  const chunks = packRecordChunks(values);
  assert.equal(chunks.length, 3);
  assert.deepEqual(unpackRecordChunks(chunks, 3), values);
  for (const chunk of chunks) assert.ok(new TextEncoder().encode(JSON.stringify(chunk)).length <= RECORD_CHUNK_BYTES);
});

test("changing one character leaves unrelated chunks identical", () => {
  const values = records(205);
  const before = packRecordChunks(values);
  const after = packRecordChunks(values.map((r, i) => i === 3 ? { ...r, data: { name: "Changed" } } : r), before);
  assert.notDeepEqual(after[0], before[0]);
  assert.deepEqual(after.slice(1), before.slice(1));
  assert.deepEqual(packRecordChunks(values, before), before);
});

test("new characters append without shifting existing chunks", () => {
  const values = records(200);
  const before = packRecordChunks(values);
  const after = packRecordChunks([...values, { id: "a_new_character", data: {} }], before);
  assert.equal(after.length, 3);
  assert.deepEqual(after.slice(0, 2), before);
});

test("UTF8 byte limits split growing records and preserve every record", () => {
  const values = records(4).map((r) => ({ ...r, text: "悲".repeat(20000) }));
  const before = packRecordChunks(values);
  assert.equal(before.length, 1);
  const grown = values.map((r, i) => i === 0 ? { ...r, text: "悲".repeat(65000) } : r);
  const after = packRecordChunks(grown, before);
  assert.ok(after.length > 1);
  assert.deepEqual(new Map(unpackRecordChunks(after, after.length).map((r) => [r.id, r])), new Map(grown.map((r) => [r.id, r])));
  assert.throws(() => packRecordChunks([{ id: "too_large", text: "悲".repeat(100000) }]), /exceeds/);
});

test("missing, duplicated or malformed chunks cannot silently erase state", () => {
  const chunks = packRecordChunks(records(101));
  assert.throws(() => unpackRecordChunks(chunks.slice(0, 1), 2), /Missing/);
  assert.throws(() => unpackRecordChunks([chunks[0], chunks[0]], 2), /Invalid/);
  const duplicated = structuredClone(chunks);
  duplicated[1].records[0] = duplicated[0].records[0];
  assert.throws(() => unpackRecordChunks(duplicated, 2), /Duplicate/);
  assert.throws(() => packRecordChunks(records(1), chunks), /Removing/);
});
