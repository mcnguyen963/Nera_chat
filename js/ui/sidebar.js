import {exportAllStories} from '../import-export.js';
import {cachedSessionIds} from '../chat-cache.js';
import {subSheet,node,button} from './memory-ui.js';
import { toast } from "./memory-ui.js";
import { friendlyError } from "../errors.js";
import { state } from "../state.js";
import { subscribeSessions, createSession, renameSession, deleteSession, duplicateSession } from "../sessions.js";
import { logout, currentUserInfo } from "../auth.js";
import { setSession, forgetChatSession, prepareChatLogout } from "./chat-view.js";

export function initSidebar() {
  const listEl = document.getElementById("session-list");
  const newBtn = document.getElementById("btn-new-session");
  const logoutBtn = document.getElementById("btn-logout");
  const userEl = document.getElementById("current-user");
  const titleEl = document.getElementById("top-bar-title");

  const me = currentUserInfo();
  if (me) userEl.textContent = me.email ?? "Signed in";

  newBtn.addEventListener("click", async () => {
    if(state.busy || newBtn.disabled)return;
    const title = prompt("Session title:", "Untitled story");
    if (title === null) return;
    newBtn.disabled=true;try {
    const id = await createSession(title.trim() || "Untitled story");
    setSession(id);
    document.querySelector('.tab[data-tab="chat"]')?.click();
    document.dispatchEvent(new CustomEvent("sidebar:close"));
    }catch(error){toast(error);}finally{newBtn.disabled=false;}
  });

  logoutBtn.addEventListener("click",async()=>{if(logoutBtn.disabled || state.busy)return;logoutBtn.disabled=true;try{await prepareChatLogout();await logout();}catch(error){toast('Sign out failed: '+friendlyError(error)+' Reload to continue.','Reload',()=>window.location.reload());}finally{logoutBtn.disabled=false;}});
  document.getElementById('btn-export-all')?.addEventListener('click',()=>{
    const controller=new AbortController(),sheet=subSheet('Download all my stories',{close:()=>{controller.abort();return true;}}),body=node('div',null,'memory-content'),progress=node('p','This reads one document per message chunk and lore card, plus each story document. Large accounts use more database reads.');
    body.append(progress,button('Download',async()=>{try{await exportAllStories({signal:controller.signal,onProgress:p=>{progress.textContent=`Exporting ${p.done} of ${p.total} stories…`;}});progress.textContent='Downloaded all stories.';}catch(error){progress.textContent=error.name==='AbortError'?'Export cancelled.':friendlyError(error);}}),button('Cancel',sheet.hide));sheet.dialog.append(body);
  });

  // Select a freshly imported session.
  document.addEventListener("session-imported", (e) => setSession(e.detail));

  let cachedSessions = [],cacheCleanupGeneration=0;
  let renderedSignature = "";
  document.addEventListener("session-changed", () => {
    refreshActive(listEl, cachedSessions, titleEl);
  });
  subscribeSessions(
    (sessions,metadata={}) => {
      const generation=++cacheCleanupGeneration;
      if(!metadata.fromCache && !metadata.hasPendingWrites){const ids=new Set(sessions.map(s=>s.id)),owner=currentUserInfo()?.uid;void cachedSessionIds(owner).then(cached=>{if(generation!==cacheCleanupGeneration || owner!==currentUserInfo()?.uid)return;for(const id of cached)if(!ids.has(id))forgetChatSession(id);}).catch(error=>console.error('Cache cleanup:',error));}
      cachedSessions = sessions;
      // The active-chat listener owns authoritative metadata; sidebar snapshots only render navigation.
      const signature = JSON.stringify(sessions.map((s) => [s.id, s.title]));
      if (signature !== renderedSignature) {
        render(listEl, sessions);
        renderedSignature = signature;
      }
      refreshActive(listEl, sessions, titleEl);
      if (sessions.length === 0) {
        if (state.sessionId) setSession(null);
        if (!listEl.querySelector(".muted")) {
          const li = document.createElement("li");
          li.className = "muted";
          li.style.padding = "10px 12px";
          li.textContent = "A blank page, a new possibility. Create your first story above.";
          listEl.appendChild(li);
        }
        return;
      }
      // Auto-select the first session if none is active or the active one vanished.
      if (!state.sessionId && sessions.length > 0) {
        setSession(sessions[0].id);
      } else if (state.sessionId && !sessions.some((s) => s.id === state.sessionId)) {
        setSession(null);
      }
    },
    (err) => {
      if(err.deletionPending){toast('Story deletion is paused. It will resume after reconnecting: '+friendlyError(err));return;}
      console.error("Sessions listener error:", err);
      renderedSignature = "";
      const me = currentUserInfo();
      listEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "error-text";
      li.style.padding = "10px 12px";
      li.textContent =
        "Error loading sessions: " + friendlyError(err) +
        (me ? ` (signed in as ${me.email ?? me.uid})` : "");
      listEl.appendChild(li);
    }
  );
}

function render(listEl, sessions) {
  listEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.dataset.sessionId = s.id;
    li.className = "session-item" + (s.id === state.sessionId ? " active" : "");

    const title = document.createElement("span");
    title.className = "session-title";
    title.tabIndex = 0;
    title.setAttribute("role", "button");
    title.setAttribute("aria-current", s.id === state.sessionId ? "true" : "false");
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); title.click(); }
    });
    title.textContent = s.title || "Untitled";

    const actions = document.createElement("span");
    actions.className = "session-actions";

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.className = "ren";
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if(renameBtn.disabled || state.busy)return;
      const t=prompt("Rename session:",s.title || "");if(!t?.trim())return;renameBtn.disabled=true;try{await renameSession(s.id,t.trim());}catch(error){toast(error);}finally{renameBtn.disabled=false;}
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "del";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (delBtn.disabled) return;
      if (state.busy) { toast('Wait for the reply to finish.');return; }
      if (!confirm(`Delete session "${s.title}" and all its messages? This cannot be undone.`)) return;
      if (state.sessionId === s.id && !setSession(null)) { toast('Wait for the reply to finish.');return; }
      delBtn.disabled=true;
      try {
        forgetChatSession(s.id);
        await deleteSession(s.id);
      } catch (error) {
        toast('Delete did not finish: '+friendlyError(error)+(error.deletionPending ? ' It will resume after reconnecting.' : ' Try again.'));
      } finally {delBtn.disabled=false;}
    });

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.className = "cpy";
    copyBtn.title = "Copy the entire session";
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (state.busy) return;
      copyBtn.disabled = true;
      copyBtn.textContent = "…";
      try {
        const newId = await duplicateSession(s.id);
        // Jump straight into the fresh copy (same event the importer uses).
        document.dispatchEvent(new CustomEvent("session-imported", { detail: newId }));
        document.dispatchEvent(new CustomEvent("sidebar:close"));
      } catch (err) {
        toast("Copy failed: "+friendlyError(err));
      } finally {
        copyBtn.disabled = false;
        copyBtn.textContent = "Copy";
      }
    });

    actions.append(renameBtn, copyBtn, delBtn);
    li.append(title, actions);
    li.addEventListener("click", () => {
      if (!setSession(s.id)) return;
      document.dispatchEvent(new CustomEvent("sidebar:close"));
    });
    listEl.appendChild(li);
  }
}

function refreshActive(listEl, sessions, titleEl) {
  const activeId = state.sessionId;
  for (const item of listEl.querySelectorAll(".session-item")) {
    const active = item.dataset.sessionId === activeId;
    item.classList.toggle("active", active);
    item.querySelector(".session-title")?.setAttribute("aria-current", String(active));
  }
  const active = sessions.find((s) => s.id === activeId);
  if (titleEl) titleEl.textContent = active?.title || "Your next story";
}
