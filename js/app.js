import { initAuth, login, register, resetPassword, changePassword, currentUserInfo } from "./auth.js";
import { loadSettings, watchSettings, DEFAULT_SETTINGS, hydrateProfiles } from "./settings.js";
import { state } from "./state.js";
import { initSidebar } from "./ui/sidebar.js";
import { initChatView, setSession } from "./ui/chat-view.js";
import { initSettingsView, openSettingsPopup } from "./ui/settings-view.js";

const el = {
  loginScreen: document.getElementById("login-screen"),
  app: document.getElementById("app"),
  loginForm: document.getElementById("login-form"),
  tabs: document.querySelectorAll(".tab"),
  chatTab: document.getElementById("chat-tab"),
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
  el.sidebarToggle?.setAttribute("aria-expanded", String(open));
}

el.sidebarToggle?.addEventListener("click", () =>
  setSidebarOpen(!document.body.classList.contains("sidebar-open"))
);
el.sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("sidebar:close", () => setSidebarOpen(false));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSidebarOpen(false);
    setTopMenuOpen(false);
    const popover = document.getElementById("composer-popover");
    if (popover) popover.hidden = true;
  }
});

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
  } else if (item.dataset.action === "settings") {
    openSettingsPopup(el.topMenuBtn);
  } else if (["summarize-full", "reset-summary", "sync-chat"].includes(item.dataset.action)) {
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
  }
});

function showAuthView(view) {
  for (const name of ["login", "register", "reset"]) {
    document.getElementById(`auth-${name}`).hidden = name !== view;
  }
  for (const id of ["login-error", "register-error", "reset-message"]) {
    setMessage(id, "");
  }
  if (view === "reset") {
    document.getElementById("reset-email").value = document.getElementById("login-username").value;
  }
}

function setMessage(id, message, error = false) {
  const node = document.getElementById(id);
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle("error-text", error);
  node.classList.toggle("success-text", !!message && !error);
}

async function submitAuth(form, buttonText, action, messageId) {
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = buttonText;
  setMessage(messageId, "");
  try {
    await action();
  } catch (err) {
    setMessage(messageId, friendlyAuthError(err), true);
  } finally {
    button.disabled = false;
    button.textContent = form.dataset.submitLabel;
  }
}

for (const button of document.querySelectorAll("[data-auth-view]")) {
  button.addEventListener("click", () => showAuthView(button.dataset.authView));
}

for (const [id, label] of [["login-form", "Sign in →"], ["register-form", "Create account →"], ["reset-form", "Send reset link →"], ["change-password-form", "Change password"]]) {
  document.getElementById(id).dataset.submitLabel = label;
}

el.loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitAuth(el.loginForm, "Signing in…", () => login(
    document.getElementById("login-username").value,
    document.getElementById("login-password").value
  ), "login-error");
});

document.getElementById("register-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const password = document.getElementById("register-password").value;
  if (password !== document.getElementById("register-confirm").value) {
    setMessage("register-error", "Passwords do not match.", true);
    return;
  }
  submitAuth(form, "Creating account…", () => register(
    document.getElementById("register-email").value, password
  ), "register-error");
});

document.getElementById("reset-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitAuth(e.currentTarget, "Sending…", async () => {
    try {
      await resetPassword(document.getElementById("reset-email").value);
    } catch (err) {
      if (err?.code !== "auth/user-not-found") throw err;
    }
    setMessage("reset-message", "If an account uses that email, a reset link is on its way.");
  }, "reset-message");
});

document.getElementById("change-password-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const next = document.getElementById("new-password").value;
  if (next !== document.getElementById("confirm-new-password").value) {
    setMessage("change-password-message", "New passwords do not match.", true);
    return;
  }
  submitAuth(form, "Updating…", async () => {
    await changePassword(document.getElementById("current-password").value, next);
    form.reset();
    setMessage("change-password-message", "Password changed successfully.");
  }, "change-password-message");
});

function friendlyAuthError(err) {
  const code = err?.code ?? "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Incorrect email or password.";
  }
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("email-already-in-use")) return "An account already uses this email. Try signing in.";
  if (code.includes("weak-password")) return "Choose a stronger password of at least 6 characters.";
  if (code.includes("too-many-requests")) return "Too many attempts. Try again later.";
  if (code.includes("network-request-failed")) return "Connection failed. Check your internet and try again.";
  if (code.includes("requires-recent-login")) return "Please sign out and sign in again, then retry.";
  if (code.includes("user-disabled")) return "This account has been disabled.";
  if (code.includes("operation-not-allowed")) {
    return "Email and password authentication is not enabled for this app.";
  }
  if (code.includes("auth/configuration-not-found")) {
    return "Authentication is not set up for this app yet.";
  }
  return "Something went wrong. Please try again.";
}

async function enterApp() {
  if (appInitialized) return;
  appInitialized = true;
  try {
    state.settings = await loadSettings();
  } catch (e) {
    console.error("Failed to load settings:", e);
    state.settings = hydrateProfiles(structuredClone(DEFAULT_SETTINGS));
    alert("Could not load your saved settings. Using defaults for this page; check your connection and Firestore rules before saving.");
  }
  initChatView();
  initSidebar();
  initSettingsView();
  watchSettings();
  document.getElementById("account-email").textContent = currentUserInfo()?.email ?? "";
  wireTabs();
}

function wireTabs() {
  el.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "settings") {
        openSettingsPopup(tab);
        document.dispatchEvent(new CustomEvent("sidebar:close"));
        return;
      }
      el.tabs.forEach((t) => t.classList.toggle("active", t === tab));
      const name = tab.dataset.tab;
      el.chatTab.classList.toggle("hidden", name !== "chat");
      document.dispatchEvent(new CustomEvent("sidebar:close"));
    });
  });
}
