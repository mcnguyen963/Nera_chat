// Device-local chat cache. Firestore remains the source for a session that has
// never been opened here; the three most recently used sessions stay in IDB.
const DATABASE = "roleplay-chat-cache";
const STORE = "sessions";
let opening;

function database() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
  return opening;
}

export async function loadChatCache(uid, sessionId) {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(`${uid}:${sessionId}`);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function saveChatCache(uid, sessionId, value) {
  const db = await database();
  if (!db) return;
  await new Promise((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put({ key: `${uid}:${sessionId}`, uid, savedAt: Date.now(), value });
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
  // Prune only this account's older entries. A cache failure never blocks chat.
  const entries = await new Promise((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => resolve([]);
  });
  const excess = entries.filter((entry) => entry.uid === uid)
    .sort((a, b) => b.savedAt - a.savedAt).slice(3);
  if (!excess.length) return;
  await new Promise((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    for (const entry of excess) transaction.objectStore(STORE).delete(entry.key);
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
}

export async function deleteChatCache(uid, sessionId) {
  const db = await database();
  if (!db) return;
  await new Promise((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(`${uid}:${sessionId}`);
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
}

export async function clearChatCache(uid) {
  const db = await database();
  if (!db) return;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.uid === uid) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear chat cache."));
    transaction.onabort = transaction.onerror;
  });
}
