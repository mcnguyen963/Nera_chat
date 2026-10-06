// SillyTavern JSONL import/export (spec §10). Chat log only, no character cards.
// Line 1 is a metadata header ({user_name, character_name, create_date}); every
// subsequent line is one message {name, is_user, send_date, mes}.

import { createSession, getSession, getSessionFromServer } from "./sessions.js";
import { getMessages, addMessagesBulk, ensureChunked } from "./messages.js";
import { currentUid } from "./auth.js";

export function parseSillyTavernJsonl(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("File is empty.");

  let title = null;
  const messages = [];

  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // skip malformed lines
    }
    if (obj.mes === undefined) {
      // Metadata header line
      if (i === 0 && obj.character_name) title = obj.character_name;
      continue;
    }
    messages.push({
      role: obj.is_user === true ? "user" : "assistant",
      content: String(obj.mes),
    });
  }

  if (messages.length === 0) throw new Error("No messages found in file.");
  return { title, messages };
}

export async function importSillyTavern(file) {
  const text = await file.text();
  const { title, messages } = parseSillyTavernJsonl(text);
  const sessionId = await createSession(title || file.name.replace(/\.jsonl$/i, "") || "Imported chat");
  // Store the imported log in bounded chunks instead of one document per turn.
  await addMessagesBulk(sessionId, messages.map((m) => ({ role: m.role, content: m.content })));
  return sessionId;
}

export async function exportSillyTavern(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("No active session to export.");
  const msgs = (await getMessages(sessionId)).filter((m) => m.role !== "summary");

  const lines = [
    JSON.stringify({
      user_name: "You",
      character_name: session.title,
      create_date: new Date().toISOString(),
    }),
  ];
  for (const m of msgs) {
    const created = m.createdAt?.toDate ? m.createdAt.toDate().toISOString() : new Date().toISOString();
    lines.push(
      JSON.stringify({
        name: m.role === "user" ? "You" : session.title,
        is_user: m.role === "user",
        send_date: created,
        mes: m.content,
      })
    );
  }

  const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeTitle = (session.title || "session").replace(/[^\w\- ]+/g, "").trim() || "session";
  a.href = url;
  a.download = safeTitle + ".jsonl";
  a.click();
  URL.revokeObjectURL(url);
}

export async function buildFullBackup(sessionId) {
  const uid = currentUid();
  const assertAccount = () => {
    if (uid !== currentUid()) throw new Error("Account changed while exporting. Try again.");
  };
  await ensureChunked(sessionId);
  assertAccount();
  const before = await getSessionFromServer(sessionId);
  assertAccount();
  if (!before) throw new Error("This story no longer exists on the server.");
  const messages = await getMessages(sessionId);
  assertAccount();
  const after = await getSessionFromServer(sessionId);
  assertAccount();
  // Every story mutation updates the session doc. Avoid producing an export
  // whose summary pointer/plan belongs to a different message snapshot.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("The story changed while exporting. Try again when both devices are idle.");
  }
  return { format: "nera-chat-backup", version: 1, exportedAt: new Date().toISOString(), session: after, messages };
}

export async function exportFullBackup(sessionId) {
  const backup = await buildFullBackup(sessionId);
  const blob = new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const title = (backup.session.title || "session").replace(/[^\w\- ]+/g, "").trim() || "session";
  link.href = url;
  link.download = title + "-backup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
