import { state } from "../state.js";
import { subscribeSessions, createSession, renameSession, deleteSession, duplicateSession } from "../sessions.js";
import { logout, currentUserInfo } from "../auth.js";
import { setSession, syncActiveSession, forgetChatSession } from "./chat-view.js";

export function initSidebar() {
  const listEl = document.getElementById("session-list");
  const newBtn = document.getElementById("btn-new-session");
  const logoutBtn = document.getElementById("btn-logout");
  const userEl = document.getElementById("current-user");
  const titleEl = document.getElementById("top-bar-title");

  const me = currentUserInfo();
  if (me) userEl.textContent = me.email ?? "Signed in";

  newBtn.addEventListener("click", async () => {
    if (state.busy) return;
    const title = prompt("Session title:", "Untitled story");
    if (title === null) return;
    const id = await createSession(title.trim() || "Untitled story");
    setSession(id);
    document.querySelector('.tab[data-tab="chat"]')?.click();
    document.dispatchEvent(new CustomEvent("sidebar:close"));
  });

  logoutBtn.addEventListener("click", () => logout());

  // Select a freshly imported session.
  document.addEventListener("session-imported", (e) => setSession(e.detail));

  let cachedSessions = [];
  let renderedSignature = "";
  document.addEventListener("session-changed", () => {
    refreshActive(listEl, cachedSessions, titleEl);
  });
  subscribeSessions(
    (sessions) => {
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
      console.error("Sessions listener error:", err);
      renderedSignature = "";
      const me = currentUserInfo();
      listEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "error-text";
      li.style.padding = "10px 12px";
      li.textContent =
        "Error loading sessions: " + (err.message || err.code || err) +
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
      const t = prompt("Rename session:", s.title || "");
      if (t && t.trim()) await renameSession(s.id, t.trim());
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "del";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (state.busy) return;
      if (!confirm(`Delete session "${s.title}" and all its messages? This cannot be undone.`)) return;
      if (state.sessionId === s.id) setSession(null);
      await deleteSession(s.id);
      forgetChatSession(s.id);
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
        alert("Copy failed: " + (err.message || err));
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
