import { initAuth, login } from "./auth.js";
import { loadSettings, DEFAULT_SETTINGS, hydrateProfiles } from "./settings.js";
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
  sidebarToggle: document.getElementById("btn-sidebar-toggle"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  topMenuBtn: document.getElementById("btn-top-menu"),
  topMenu: document.getElementById("top-menu"),
};

let appInitialized = false;

// Keep the app at the *visual* viewport height so the iOS keyboard never
// hides the composer (100dvh alone is unreliable on iOS). iOS also pushes
// the whole page up when an input is focused; undo that push so the app
// stays glued to the top of the keyboard instead of floating above it.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const syncViewport = () => {
    document.documentElement.style.setProperty("--app-height", vv.height + "px");
    // While pinch-zoomed, panning the visual viewport is intentional.
    if (vv.scale === 1 && (window.scrollX !== 0 || window.scrollY !== 0)) {
      window.scrollTo(0, 0);
    }
  };
  vv.addEventListener("resize", syncViewport);
  vv.addEventListener("scroll", syncViewport);
  // Element scrolls don't fire this; only the document scroll does.
  window.addEventListener("scroll", syncViewport, { passive: true });
  syncViewport();
}

// ---------- mobile sidebar drawer ----------
function setSidebarOpen(open) {
  document.body.classList.toggle("sidebar-open", open);
  el.app?.classList.toggle("sidebar-open", open);
  if (el.sidebarBackdrop) el.sidebarBackdrop.hidden = !open;
}

el.sidebarToggle?.addEventListener("click", () =>
  setSidebarOpen(!document.body.classList.contains("sidebar-open"))
);
el.sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("sidebar:close", () => setSidebarOpen(false));

// ---------- compact top menu (mobile) ----------
function setTopMenuOpen(open) {
  if (el.topMenu) el.topMenu.hidden = !open;
}

el.topMenuBtn?.addEventListener("click", () =>
  setTopMenuOpen(el.topMenu.hidden)
);

el.topMenu?.addEventListener("click", (e) => {
  const item = e.target.closest(".top-menu-item");
  if (!item) return;
  setTopMenuOpen(false);
  if (item.dataset.action === "sessions") {
    setSidebarOpen(true);
  } else if (item.dataset.action === "summarize-full" || item.dataset.action === "reset-summary") {
    document.dispatchEvent(new CustomEvent(item.dataset.action));
  } else {
    // Reuse the existing tab logic; the tab buttons are just CSS-hidden.
    document.querySelector(`.tab[data-tab="${item.dataset.action}"]`)?.click();
  }
});

// Close the menu when tapping anywhere else.
document.addEventListener("click", (e) => {
  if (el.topMenu && !el.topMenu.hidden && !e.target.closest(".top-menu-wrap")) {
    setTopMenuOpen(false);
  }
});

// Auth gate: the UI is shown only when Firebase Auth reports a signed-in user.
initAuth((user) => {
  // Tear down account-scoped listeners and in-flight work on auth transitions.
  if (appInitialized) {
    window.location.reload();
    return;
  }
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
    el.loginNote.textContent = "Warning: could not load your settings — check Firestore rules.";
    el.loginNote.style.color = "var(--danger)";
    state.settings = hydrateProfiles(structuredClone(DEFAULT_SETTINGS));
    alert("Could not load your saved settings. Using defaults for this page; check your connection and Firestore rules before saving.");
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
      document.dispatchEvent(new CustomEvent("sidebar:close"));
    });
  });

  // Mobile: the tab bar is hidden, so Settings needs its own way back.
  document.getElementById("btn-back-to-chat")?.addEventListener("click", () => {
    document.querySelector('.tab[data-tab="chat"]')?.click();
  });
}
