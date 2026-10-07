import { getLore, importLore } from './lore-store.js';
import { formatTurnsTranscript, computeTurns } from './turns.js';
import { normalizeMemory } from './memory-settings.js';
// SillyTavern JSONL import/export (spec §10). Chat log only, no character cards.
// Line 1 is a metadata header ({user_name, character_name, create_date}); every
// subsequent line is one message {name, is_user, send_date, mes}.

import { createSession, getSession, updateSession } from "./sessions.js";
import { getMessages, addMessagesBulk } from "./messages.js";

export function parseSillyTavernJsonl(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("File is empty.");

  let title = null, metadata = null;
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
      if (i === 0 && obj.nera?.version === 2) metadata = obj.nera;
      continue;
    }
    messages.push({
      ...(obj.nera?.message ?? {}),
      role:obj.nera?.message?.role ?? (obj.is_user === true ? "user" : "assistant"),content:String(obj.mes),
    });
  }

  if (messages.length === 0) throw new Error("No messages found in file.");
  return { title,messages,metadata };
}

export async function importSillyTavern(file) {
  const text = await file.text();
  const { title,messages,metadata } = parseSillyTavernJsonl(text);
  const sessionId = await createSession(title || file.name.replace(/\.jsonl$/i, "") || "Imported chat");
  // Store the imported log in bounded chunks instead of one document per turn.
  await addMessagesBulk(sessionId,messages);
  if (metadata?.session) {
    const allowed = ['longTermPlan','memory','memoryState','activeSummaryMessageId','breakpointOrder','memoryInvalidations','historyRevision','nextNarratorTurn'];
    const patch=Object.fromEntries(allowed.filter(k=>k in metadata.session).map(k=>[k,metadata.session[k]]));
    if(patch.memory?.autoUpdate && patch.memoryState?.extractedThroughOrder==null){patch.memoryState={...patch.memoryState,extractedThroughOrder:Array.isArray(metadata.lore) && metadata.lore.length ? messages.filter(m=>m.role==='assistant').at(-1)?.order ?? messages.reduce((last,m,i)=>m.role==='assistant'?i+1:last,0) : 0};}
    await updateSession(sessionId,patch);
    if (Array.isArray(metadata.lore)) await importLore(sessionId,{ writes:metadata.lore.map(e => ({ id:e.id,data:e })) },[]);
  }
  return sessionId;
}

export async function exportSillyTavern(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("No active session to export.");
  const msgs = await getMessages(sessionId);
  const lore = await getLore(sessionId);

  const lines = [
    JSON.stringify({
      user_name: "You",
      character_name: session.title,
      create_date: new Date().toISOString(),
      nera:{ version:2,session:Object.fromEntries(["longTermPlan","memory","memoryState","activeSummaryMessageId","breakpointOrder","memoryInvalidations","historyRevision","nextNarratorTurn"].filter(k => k in session).map(k => [k,session[k]])),lore },
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
        nera:{ message:m },
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

export async function exportTranscriptForLorebooks(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error('No active session to export.');
  const messages = await getMessages(sessionId);
  const text = formatTurnsTranscript(messages, computeTurns(messages), { title: session.title, protagonist: normalizeMemory(session.memory).protagonist });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a'); link.href = url; link.download = (session.title || 'story')+'-transcript.txt'; link.click(); URL.revokeObjectURL(url);
}
