import { initAuth, login } from "./auth.js";
import { loadSettings } from "./settings.js";
import { state } from "./state.js";
import { initSidebar } from "./ui/sidebar.js";
import { initChatView, setSession } from "./ui/chat-view.js";
import { initSettingsView } from "./ui/settings-view.js";

const el = {
  loginScreen: document.getElementById("login-screen"),
  app: document.getElementById("app"),
  loginForm: document.getElementById("login-form"),
  loginError: document.getElementById("login-error"),
  loginNote: document.getElementById("login-note"),
  tabs: document.querySelectorAll(".tab"),
  chatTab: document.getElementById("chat-tab"),
  settingsTab: document.getElementById("settings-tab"),
};

let appInitialized = false;

// Auth gate: the UI is shown only when Firebase Auth reports a signed-in user.
initAuth((user) => {
  if (user) {
    el.loginScreen.classList.add("hidden");
    el.app.classList.remove("hidden");
    enterApp();
  } else {
    el.app.classList.add("hidden");
    el.loginScreen.classList.remove("hidden");
    el.loginNote.textContent = "Sign in with your Firebase Auth account.";
  }
});

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.loginError.textContent = "";
  const username = document.getElementById("login-username").value;
  const password = document.getElementById("login-password").value;
  try {
    await login(username, password);
    // onAuthStateChanged callback drives the UI switch.
  } catch (err) {
    el.loginError.textContent = "Login failed: " + friendlyAuthError(err);
  }
});

function friendlyAuthError(err) {
  const code = err?.code ?? "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "incorrect email or password.";
  }
  if (code.includes("invalid-email")) return "invalid email address.";
  if (code.includes("too-many-requests")) return "too many attempts — try again later.";
  if (code.includes("operation-not-allowed")) {
    return "Email/Password sign-in is not enabled in your Firebase project (Authentication → Sign-in method).";
  }
  if (code.includes("auth/configuration-not-found")) {
    return "Firebase Authentication is not set up for this project yet.";
  }
  return err.message ?? String(err);
}

async function enterApp() {
  if (appInitialized) return;
  appInitialized = true;
  try {
    state.settings = await loadSettings();
  } catch (e) {
    console.error("Failed to load settings:", e);
    el.loginNote.textContent = "Warning: could not load /settings/global — check Firestore rules.";
    el.loginNote.style.color = "var(--danger)";
    // Still enter; settings-view will fill with defaults once available.
    state.settings = null;
  }
  initChatView();
  initSidebar();
  initSettingsView();
  wireTabs();
}

function wireTabs() {
  el.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      el.tabs.forEach((t) => t.classList.toggle("active", t === tab));
      const name = tab.dataset.tab;
      el.chatTab.classList.toggle("hidden", name !== "chat");
      el.settingsTab.classList.toggle("hidden", name !== "settings");
      if (name === "settings") {
        // Re-fill the This-Session section each time the tab opens.
        document.dispatchEvent(new CustomEvent("session-changed"));
      }
    });
  });
}
