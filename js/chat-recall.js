// Optional recall code. chat-view imports this module only after recall is enabled.
// The local index stores keywords and short snippets. Full message text is
// fetched only for selected matches.
import { getRecallPage, getRecallMatches } from "./messages.js";
import { currentUid } from "./auth.js";
import { state } from "./state.js";

const DB_NAME = "roleplay-recall";
const STOP_WORDS = new Set("the and for with from that this have were your about into their they them then than what when where will would could should there here was are you she him her his its but not all who how why can did had has our out too very just now same been more some only also after before".split(" "));
let opening;
const indexing = new Set();
const background = new Set();

function terms(text) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((word) => !STOP_WORDS.has(word));
  const distinct = [...new Set(words)];
  return distinct.length <= 80 ? distinct : [...distinct.slice(0, 40), ...distinct.slice(-40)];
}

function database() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4);
    request.onupgradeneeded = (event) => {
      for (const name of ["terms", "vectors", "progress"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      const store = request.transaction.objectStore("terms");
      if (!store.indexNames.contains("byScopeTerm"))
        store.createIndex("byScopeTerm", "searchTerms", { multiEntry: true });
      if (event.oldVersion > 0) {
        for (const name of Array.from(request.result.objectStoreNames))
          request.transaction.objectStore(name).clear();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
  return opening;
}

function prefix(sessionId) { return `${currentUid()}:${sessionId}:`; }
function rowKey(sessionId, order) { return prefix(sessionId) + String(order).padStart(12, "0"); }

function get(db, store, key) {
  return new Promise((resolve) => {
    const request = db.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

async function saveRows(db, sessionId, messages, progress, chunkId) {
  await new Promise((resolve) => {
    const tx = db.transaction(["terms", "progress"], "readwrite");
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const key = rowKey(sessionId, message.order);
      tx.objectStore("terms").put({ id: message.id, order: message.order,
        role: message.role, chunkId, snippet: message.content.slice(-2000),
        searchTerms: terms(message.content).map((word) => prefix(sessionId) + word) }, key);
    }
    if (progress) tx.objectStore("progress").put(progress, prefix(sessionId));
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

async function indexPage(db, session) {
  const key = prefix(session.id);
  if (indexing.has(key)) return;
  indexing.add(key);
  try {
    const progress = await get(db, "progress", key);
    if (progress?.complete) return;
    const beforeOrder = progress?.beforeOrder ?? (session.nextOrder ?? 0) + 1;
    const page = await getRecallPage(session.id, beforeOrder);
    const next = page.messages.length ? Math.min(...page.messages.map((m) => m.order)) : beforeOrder;
    await saveRows(db, session.id, page.messages,
      { beforeOrder: next, complete: !page.messages.length || next <= 1 }, page.chunkId);
  } finally {
    indexing.delete(key);
  }
}

function continueInBackground(db, session) {
  const key = prefix(session.id);
  if (background.has(key)) return;
  background.add(key);
  const schedule = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 5000 })
    : (fn) => window.setTimeout(fn, 1000);
  const step = async () => {
    if (document.hidden || state.settings?.chatRecallEnabled !== true || state.sessionId !== session.id) {
      background.delete(key);
      return;
    }
    if (state.busy) { schedule(step); return; }
    try {
      const progress = await get(db, "progress", prefix(session.id));
      if (progress?.complete) { background.delete(key); return; }
      await indexPage(db, session);
      schedule(step);
    } catch { background.delete(key); /* Retry on a later turn. */ }
  };
  schedule(step);
}

async function search(db, sessionId, queryTerms, excluded, upToOrder) {
  const matches = new Map();
  const words = queryTerms.slice(-12);
  await new Promise((resolve) => {
    const tx = db.transaction("terms", "readonly");
    const index = tx.objectStore("terms").index("byScopeTerm");
    let remaining = words.length;
    for (const word of words) {
      let seen = 0;
      const request = index.openCursor(IDBKeyRange.only(prefix(sessionId) + word), "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || seen++ >= 500) { if (--remaining === 0) resolve(); return; }
        const row = cursor.value;
        if (row.order < upToOrder && !excluded.has(row.id)) {
          const previous = matches.get(row.id);
          matches.set(row.id, { ...row, score: (previous?.score ?? 0) + 1 });
        }
        cursor.continue();
      };
      request.onerror = () => { if (--remaining === 0) resolve(); };
    }
    tx.onerror = resolve;
  });
  return [...matches.values()]
    .sort((a, b) => b.score - a.score || b.order - a.order).slice(0, 24);
}

async function embedding(settings, input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(settings.embeddingEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.embeddingApiKey}` },
      body: JSON.stringify({ model: settings.embeddingModelId, input }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Embedding API error ${response.status}`);
    const data = await response.json();
    const ordered = (data.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
    if (ordered.length !== input.length || ordered.some((vector) => !Array.isArray(vector)))
      throw new Error("Embedding response did not contain the requested vectors.");
    return ordered;
  } finally { clearTimeout(timer); }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

async function semanticRerank(db, sessionId, settings, queryText, candidates) {
  const version = `${settings.embeddingEndpoint}|${settings.embeddingModelId}`;
  const keys = candidates.map((row) => `${prefix(sessionId)}${version}:${row.id}`);
  const cached = await Promise.all(keys.map((key) => get(db, "vectors", key)));
  const missing = candidates.map((_, index) => index).filter((index) => !cached[index]);
  const queryVector = (await embedding(settings, [queryText.slice(-4000)]))[0];
  if (missing.length) {
    const vectors = await embedding(settings, missing.map((index) => candidates[index].snippet));
    await new Promise((resolve) => {
      const tx = db.transaction("vectors", "readwrite");
      missing.forEach((index, i) => {
        cached[index] = new Float32Array(vectors[i]);
        tx.objectStore("vectors").put(cached[index], keys[index]);
      });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  }
  candidates.forEach((row, index) => { row.semanticScore = cosine(queryVector, cached[index]); });
  candidates.sort((a, b) => b.semanticScore - a.semanticScore || b.score - a.score);
}

export async function findRecalledMessages(session, settings, opts) {
  if (settings.chatRecallEnabled !== true || opts.maxTokens <= 0) return { messages: [] };
  const latestOrder = Math.max(session.nextOrder ?? 0, ...opts.messages.map((m) => m.order));
  const queryMessage = [...opts.messages].reverse().find((m) => m.role === "user" && m.order < opts.upToOrder);
  const queryText = queryMessage?.content ?? "";
  const queryTerms = terms(queryText);
  if (!queryTerms.length) return { messages: [] };
  const db = await database();
  if (!db) {
    const page = await getRecallPage(session.id, latestOrder + 1);
    const wanted = new Set(queryTerms.slice(-12));
    const messages = page.messages.filter((m) => (m.role === "user" || m.role === "assistant") &&
      m.order < opts.upToOrder && m.id !== queryMessage?.id && !opts.excludedIds.has(m.id))
      .map((m) => ({ ...m, score: terms(m.content).filter((word) => wanted.has(word)).length }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || b.order - a.order).slice(0, 24);
    return { messages, warning: "Local index unavailable; searched recent history only." };
  }
  const recent = opts.messages.filter((m) => m.role === "user" || m.role === "assistant").slice(-4);
  await saveRows(db, session.id, recent);
  const indexSession = { ...session, nextOrder: latestOrder };
  try { await indexPage(db, indexSession); } catch { /* Indexed history can still be searched. */ }
  continueInBackground(db, indexSession);
  const excluded = new Set(opts.excludedIds);
  if (queryMessage) excluded.add(queryMessage.id);
  const candidates = await search(db, session.id, queryTerms, excluded, opts.upToOrder);
  if (!candidates.length) return { messages: [] };
  let warning = null;
  if (settings.semanticSearchEnabled === true) {
    try { await semanticRerank(db, session.id, settings, queryText, candidates); }
    catch (error) { warning = `Semantic search unavailable; using keywords. ${error.message}`; }
  }
  const messages = await getRecallMatches(session.id, candidates.slice(0, 12));
  return { messages, warning };
}

export async function invalidateRecallSession(sessionId) {
  const db = await database();
  if (!db) return;
  const p = prefix(sessionId);
  await Promise.all(["terms", "vectors", "progress"].map((name) => new Promise((resolve) => {
    const tx = db.transaction(name, "readwrite");
    const request = tx.objectStore(name).openKeyCursor(IDBKeyRange.bound(p, p + "\uffff"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { tx.objectStore(name).delete(cursor.key); cursor.continue(); }
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  })));
}

export async function clearRecallIndex() {
  const db = await database();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(["terms", "vectors", "progress"], "readwrite");
    for (const name of ["terms", "vectors", "progress"]) tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}
