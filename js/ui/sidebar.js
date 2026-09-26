import { state } from "../state.js";
import { subscribeSessions, createSession, renameSession, deleteSession } from "../sessions.js";
import { logout } from "../auth.js";
import { setSession } from "./chat-view.js";

export function initSidebar() {
  const listEl = document.getElementById("session-list");
  const newBtn = document.getElementById("btn-new-session");
  const logoutBtn = document.getElementById("btn-logout");

  newBtn.addEventListener("click", async () => {
    const title = prompt("Session title:", "New Session");
    if (title === null) return;
    await createSession(title.trim() || "New Session");
  });

  logoutBtn.addEventListener("click", () => logout());

  // Select a freshly imported session.
  document.addEventListener("session-imported", (e) => setSession(e.detail));

  subscribeSessions(
    (sessions) => {
      render(listEl, sessions);
      if (sessions.length === 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.style.padding = "10px 12px";
        li.textContent = "No sessions yet — use + New or Settings → Import.";
        listEl.appendChild(li);
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
      listEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "error-text";
      li.style.padding = "10px 12px";
      li.textContent = "Error loading sessions: " + (err.message || err.code || err);
      listEl.appendChild(li);
    }
  );
}

function render(listEl, sessions) {
  listEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === state.sessionId ? " active" : "");

    const title = document.createElement("span");
    title.className = "session-title";
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
      if (!confirm(`Delete session "${s.title}" and all its messages? This cannot be undone.`)) return;
      if (state.sessionId === s.id) setSession(null);
      await deleteSession(s.id);
    });

    actions.append(renameBtn, delBtn);
    li.append(title, actions);
    li.addEventListener("click", () => setSession(s.id));
    listEl.appendChild(li);
  }
}
