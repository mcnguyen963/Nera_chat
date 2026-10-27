import {routeTopMenu} from './ui/menu-routing.js';
import {initIcons} from './ui/icons.js';
import {initVersion} from './version.js';
import {installErrorHandlers,friendlyError} from './errors.js';
import {toast,activeSheet} from './ui/memory-ui.js';
import {clearAccountCaches} from './device-caches.js';
import { initViewport } from "./viewport.js";
import { initLorebookView } from './ui/lorebook-view.js';
import { initContextViewer } from './ui/context-viewer.js';
import { stopAll } from './memory-updater.js';
import { initAuth, login, resetPassword, changePassword, currentUserInfo } from "./auth.js";
import { loadSettings, watchSettings, DEFAULT_SETTINGS, hydrateProfiles } from "./settings.js";
import { state } from "./state.js";
import { initSidebar } from "./ui/sidebar.js";
import { initChatView, setSession, prepareChatLogout } from "./ui/chat-view.js";
import { initSettingsView, openSettingsPopup } from "./ui/settings-view.js";

const el = {
  loginScreen: document.getElementById("login-screen"),
  app: document.getElementById("app"),
  loginForm: document.getElementById("login-form"),
  chatTab: document.getElementById("chat-tab"),
  sidebarToggle: document.getElementById("btn-sidebar-toggle"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  topMenuBtn: document.getElementById("btn-top-menu"),
  topMenu: document.getElementById("top-menu"),
};

let appInitialized = false;
// Portal the menu outside the blurred header: a backdrop filter would otherwise
// make the phone's fixed bottom sheet relative to the 52px header.
el.app.append(el.topMenu);
const menuBackdrop = document.createElement('div');
menuBackdrop.className = 'top-menu-backdrop'; menuBackdrop.hidden = true;
el.app.append(menuBackdrop);
menuBackdrop.addEventListener('click', () => setTopMenuOpen(false));

// Keep the app at the *visual* viewport height so the iOS keyboard never
// hides the composer (100dvh alone is unreliable on iOS). iOS also pushes
// the whole page up when an input is focused; undo that push so the app
// stays glued to the top of the keyboard instead of floating above it.
initViewport();
initIcons();
installErrorHandlers({show:toast});
initVersion();

// ---------- mobile sidebar drawer ----------
function setSidebarOpen(open) {
  document.body.classList.toggle("sidebar-open", open);
  el.app?.classList.toggle("sidebar-open", open);
  if (el.sidebarBackdrop) el.sidebarBackdrop.hidden = !open;
  el.sidebarToggle?.setAttribute("aria-expanded", String(open));
  const drawer = document.getElementById('sidebar');
  if (drawer) drawer.inert = !open;
  document.querySelector('.main').inert = open;
  if (open) document.getElementById('btn-sidebar-close')?.focus({preventScroll:true});
  else if (drawer?.contains(document.activeElement)) el.sidebarToggle?.focus({preventScroll:true});
  document.dispatchEvent(new CustomEvent('ui-surface-change'));
}

el.sidebarToggle?.addEventListener("click", () =>
  setSidebarOpen(!document.body.classList.contains("sidebar-open"))
);
document.getElementById('btn-sidebar-close')?.addEventListener('click', () => setSidebarOpen(false));
el.sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("sidebar:close", () => setSidebarOpen(false));

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || activeSheet() || document.querySelector('dialog[open]')) return;
  if (event.key === "Escape") {
    setSidebarOpen(false);
    setTopMenuOpen(false);
  }
});

// ---------- compact top menu (mobile) ----------
function setTopMenuOpen(open) {
  if (el.topMenu) el.topMenu.hidden = !open;
  menuBackdrop.hidden = !open;
  el.topMenuBtn?.setAttribute('aria-expanded', String(open));
  if (open) el.topMenu?.querySelector('button:not(:disabled):not(.hidden)')?.focus();
  else if (el.topMenu?.contains(document.activeElement)) el.topMenuBtn?.focus({preventScroll:true});
  document.dispatchEvent(new CustomEvent('ui-surface-change'));
}

el.topMenuBtn?.addEventListener("click", () =>
  setTopMenuOpen(el.topMenu.hidden)
);

el.topMenu?.addEventListener("click", (e) => {
  const item = e.target.closest(".top-menu-item");
  if (!item || item.disabled) return;
  setTopMenuOpen(false);
  routeTopMenu(item.dataset.action, {
    settings: () => openSettingsPopup(el.topMenuBtn),
    dispatch: name => document.dispatchEvent(new CustomEvent(name)),
  });
}, true);

// Keep keyboard navigation inside an open drawer or actions sheet.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || activeSheet() || document.querySelector('dialog[open]')) return;
  if (event.key !== 'Tab') return;
  const root = document.body.classList.contains('sidebar-open') ? document.getElementById('sidebar') : !el.topMenu.hidden ? el.topMenu : null;
  if (!root) return;
  const items = [...root.querySelectorAll('button, a, [tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

// Close the menu when tapping anywhere else.
document.addEventListener("click", (e) => {
  if (el.topMenu && !el.topMenu.hidden && !e.target.closest(".top-menu-wrap") && !el.topMenu.contains(e.target)) {
    setTopMenuOpen(false);
  }
});

// Auth gate: the UI is shown only when Firebase Auth reports a signed-in user.
let previousAuthUid=null;
initAuth(async(user)=>{
  const previous=previousAuthUid;previousAuthUid=user?.uid ?? null;
  // Tear down account-scoped listeners and in-flight work on auth transitions.
  if (appInitialized) {
    stopAll();
    await prepareChatLogout();
    if(previous && previous!==user?.uid)await clearAccountCaches(previous);
    window.location.reload();
    return;
  }
  if (user) {
    el.loginScreen.classList.add("hidden");
    el.app.classList.remove("hidden");
    enterApp().catch(showBootError);
  } else {
    el.app.classList.add("hidden");
    el.loginScreen.classList.remove("hidden");
  }
});

function showBootError(error){console.error(error);el.app.classList.add("hidden");el.loginScreen.classList.remove("hidden");setMessage("login-error","Could not start the app: "+friendlyError(error)+" Reload to try again.",true);}

function showAuthView(view) {
  for (const name of ["login", "reset"]) {
    document.getElementById(`auth-${name}`).hidden = name !== view;
  }
  for (const id of ["login-error", "reset-message"]) {
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

for (const [id, label] of [["login-form", "Sign in →"], ["reset-form", "Send reset link →"], ["change-password-form", "Change password"]]) {
  document.getElementById(id).dataset.submitLabel = label;
}

el.loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitAuth(el.loginForm, "Signing in…", () => login(
    document.getElementById("login-username").value,
    document.getElementById("login-password").value
  ), "login-error");
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
    alert("Could not load your saved settings. Using defaults for this page. Reload before saving settings.");
  }
  initChatView();
  initSidebar();
  initSettingsView();
  initLorebookView();
  initContextViewer();
  watchSettings();
  document.getElementById("account-email").textContent = currentUserInfo()?.email ?? "";
}
