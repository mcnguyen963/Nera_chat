// SillyTavern JSONL import/export (spec §10). Chat log only, no character cards.
// Line 1 is a metadata header ({user_name, character_name, create_date}); every
// subsequent line is one message {name, is_user, send_date, mes}.

import { createSession, getSession } from "./sessions.js";
import { getMessages, addMessage } from "./messages.js";

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
  for (const m of messages) {
    await addMessage(sessionId, { role: m.role, content: m.content });
  }
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
