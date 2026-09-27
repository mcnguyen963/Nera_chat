// Keep ordinary chunks well below Firestore's 1 MiB document limit. JSON size
// is only an estimate of Firestore's encoded size, so leave generous headroom.
export const TARGET_CHUNK_BYTES = 256 * 1024;
export const MAX_SINGLE_MESSAGE_BYTES = 850 * 1024;
export const MAX_MESSAGES_PER_CHUNK = 100;
const CHUNK_OVERHEAD_BYTES = 1024;
const MESSAGE_OVERHEAD_BYTES = 128;
const encoder = new TextEncoder();

export function messageBytes(message) {
  return encoder.encode(JSON.stringify(message)).length + MESSAGE_OVERHEAD_BYTES;
}

export function chunkBytes(messages) {
  return CHUNK_OVERHEAD_BYTES + messages.reduce((sum, message) => sum + messageBytes(message), 0);
}

export function packMessages(messages) {
  const groups = [];
  let group = [];
  let bytes = CHUNK_OVERHEAD_BYTES;
  for (const message of messages) {
    const size = messageBytes(message);
    if (size > MAX_SINGLE_MESSAGE_BYTES) {
      throw new Error(`Message ${message.id} is too large for a Firestore chunk.`);
    }
    if (group.length && (group.length >= MAX_MESSAGES_PER_CHUNK || bytes + size > TARGET_CHUNK_BYTES)) {
      groups.push(group);
      group = [];
      bytes = CHUNK_OVERHEAD_BYTES;
    }
    group.push(message);
    bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

export function chunkId(firstOrder) {
  return `chunk_${String(firstOrder).padStart(12, "0")}`;
}

export function chunkRecord(messages, firstOrder = messages[0].order, lastOrder = messages.at(-1).order) {
  return { firstOrder, lastOrder, count: messages.length, byteSize: chunkBytes(messages), messages };
}
