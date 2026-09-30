// Pack current state records together; events and dialogue retain their stores.
export const RECORD_CHUNK_BYTES = 250 * 1024;
export const RECORD_CHUNK_ITEMS = 100;
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const chunkId = (index) => `chunk_${String(index).padStart(6, "0")}`;
const document = (index, records) => ({ id: chunkId(index), records });

export function unpackRecordChunks(chunks, expectedCount) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || chunks.length !== expectedCount)
    throw new Error("Missing or invalid continuity record chunks.");
  const ordered = [...chunks].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ids = new Set();
  ordered.forEach((chunk, index) => {
    if (chunk.id !== chunkId(index) || !Array.isArray(chunk.records) || !chunk.records.length ||
        chunk.records.length > RECORD_CHUNK_ITEMS || bytes(chunk) > RECORD_CHUNK_BYTES)
      throw new Error("Invalid continuity record chunk.");
    for (const record of chunk.records) {
      if (!record?.id || ids.has(record.id)) throw new Error("Duplicate or invalid chunked record.");
      ids.add(record.id);
    }
  });
  return ordered.flatMap((chunk) => chunk.records);
}

// Keep existing records in their chunk. Growth spills into new chunks rather
// than moving every subsequent record and rewriting unrelated documents.
export function packRecordChunks(records, previous = []) {
  unpackRecordChunks(previous, previous.length);
  previous = [...previous].sort((a, b) => a.id.localeCompare(b.id));
  const remaining = new Map(records.map((record) => [record.id, record]));
  if (remaining.size !== records.length) throw new Error("Duplicate continuity record.");
  const groups = previous.map((chunk) => chunk.records.map((old) => {
    const record = remaining.get(old.id);
    if (!record) throw new Error("Removing a saved record requires an explicit state rebuild.");
    remaining.delete(old.id);
    return record;
  }));
  const added = [...remaining.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (added.length) {
    if (!groups.length) groups.push([]);
    groups.at(-1).push(...added);
  }
  const result = [];
  const overflow = [];
  groups.forEach((group, index) => {
    const current = [];
    for (const record of group) {
      if (current.length >= RECORD_CHUNK_ITEMS || bytes(document(index, [...current, record])) > RECORD_CHUNK_BYTES) {
        overflow.push(record);
      } else current.push(record);
    }
    if (current.length) result.push(document(index, current));
    else throw new Error("A continuity record exceeds the chunk storage limit.");
  });
  for (const record of overflow) {
    let last = result.at(-1);
    if (!last || last.records.length >= RECORD_CHUNK_ITEMS || bytes({ ...last, records: [...last.records, record] }) > RECORD_CHUNK_BYTES) {
      last = document(result.length, []);
      result.push(last);
    }
    last.records.push(record);
    if (bytes(last) > RECORD_CHUNK_BYTES) throw new Error("A continuity record exceeds the chunk storage limit.");
  }
  unpackRecordChunks(result, result.length);
  return result;
}
