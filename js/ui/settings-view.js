import { state } from "../state.js";
import {
  saveSettings,
  normalizeProfiles,
  activeProfile,
  mirrorToActiveProfile,
} from "../settings.js";
import { getSession, updateSession } from "../sessions.js";
import { importSillyTavern, exportSillyTavern } from "../import-export.js";
import { refreshContextIndicator } from "./chat-view.js";

const el = {};

export function initSettingsView() {
  el.endpoint = document.getElementById("set-endpoint");
  el.apikey = document.getElementById("set-apikey");
  el.model = document.getElementById("set-model");
  el.maxResp = document.getElementById("set-max-resp");
  el.streaming = document.getElementById("set-streaming");
  el.reasoningEnabled = document.getElementById("set-reasoning-enabled");
  el.reasoningMode = document.getElementById("set-reasoning-mode");
  el.reasoningEffort = document.getElementById("set-reasoning-effort");
  el.reasoningMaxTokens = document.getElementById("set-reasoning-maxtokens");
  el.maxContext = document.getElementById("set-max-context");
  el.autoThreshold = document.getElementById("set-auto-threshold");
  el.keepN = document.getElementById("set-keep-n");
  el.narratorPrompt = document.getElementById("set-narrator-prompt");
  el.summarizerPrompt = document.getElementById("set-summarizer-prompt");
  el.savedMsg = document.getElementById("settings-saved-msg");
  el.sessionTitle = document.getElementById("set-session-title");
  el.sessionPlan = document.getElementById("set-session-plan");
  el.saveBtn = document.getElementById("btn-save-settings");
  el.profiles = document.getElementById("set-profiles");
  el.profileName = document.getElementById("set-profile-name");
  el.profileCopy = document.getElementById("btn-profile-copy");
  el.profileDelete = document.getElementById("btn-profile-delete");
  el.saveSessionBtn = document.getElementById("btn-save-session");
  el.importBtn = document.getElementById("btn-import-st");
  el.importFile = document.getElementById("file-import-st");
  el.exportBtn = document.getElementById("btn-export-st");

  el.saveBtn.addEventListener("click", handleSaveSettings);
  el.profiles.addEventListener("change", handleProfileSwitch);
  el.profileCopy.addEventListener("click", handleProfileCopy);
  el.profileDelete.addEventListener("click", handleProfileDelete);
  el.saveSessionBtn.addEventListener("click", handleSaveSession);
  el.importBtn.addEventListener("click", () => el.importFile.click());
  el.importFile.addEventListener("change", handleImport);
  el.exportBtn.addEventListener("click", handleExport);

  document.addEventListener("session-changed", fillSessionSection);
  fillGlobal();
  fillSessionSection();
}

// ---------- global settings ----------

function fillGlobal() {
  const s = state.settings;
  if (!s) return;
  fillProfileSelect();
  el.endpoint.value = s.endpoint ?? "";
  el.apikey.value = s.apiKey ?? "";
  el.model.value = s.modelId ?? "";
  el.maxResp.value = s.maxResponseTokens ?? 1024;
  el.streaming.checked = !!s.streaming;
  el.reasoningEnabled.checked = !!s.reasoning?.enabled;
  el.reasoningMode.value = s.reasoning?.mode ?? "effort";
  el.reasoningEffort.value = s.reasoning?.effort ?? "medium";
  el.reasoningMaxTokens.value = s.reasoning?.maxTokens ?? 2000;
  el.maxContext.value = s.maxContextTokens ?? 8000;
  el.autoThreshold.value = s.autoSummaryThresholdPercent ?? 70;
  el.keepN.value = s.keepRecentMessagesAfterSummary ?? 10;
  el.narratorPrompt.value = s.narratorSystemPrompt ?? "";
  el.summarizerPrompt.value = s.summarizerSystemPrompt ?? "";
}

// ---------- connection profiles ----------

function fillProfileSelect() {
  const s = state.settings;
  el.profiles.replaceChildren(
    ...s.profiles.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      return o;
    })
  );
  el.profiles.value = s.activeProfileId;
  el.profileName.value = activeProfile(s)?.name ?? "";
}

function collectConnection() {
  return {
    endpoint: el.endpoint.value.trim(),
    apiKey: el.apikey.value.trim(),
    modelId: el.model.value.trim(),
    maxResponseTokens: Number(el.maxResp.value) || 1024,
    streaming: el.streaming.checked,
    reasoning: {
      enabled: el.reasoningEnabled.checked,
      mode: el.reasoningMode.value,
      effort: el.reasoningEffort.value,
      maxTokens: Number(el.reasoningMaxTokens.value) || 2000,
    },
  };
}

// Persist the form's connection fields into the current profile, then switch
// to the newly selected one and reload the form from it.
async function handleProfileSwitch() {
  const s = { ...state.settings, ...collectConnection() };
  const cur = activeProfile(s);
  cur.name = el.profileName.value.trim() || cur.name || "Default";
  mirrorToActiveProfile(s);
  s.activeProfileId = el.profiles.value;
  normalizeProfiles(s);
  state.settings = s;
  fillGlobal();
  try {
    await saveSettings(s);
  } catch (e) {
    flashSaved("Save failed: " + e.message, true);
  }
}

async function handleProfileCopy() {
  const s = { ...state.settings, ...collectConnection() };
  normalizeProfiles(s);
  const cur = activeProfile(s);
  cur.name = el.profileName.value.trim() || cur.name || "Default";
  mirrorToActiveProfile(s);
  const copy = {
    ...structuredClone(cur),
    id: "p" + Date.now().toString(36),
    name: cur.name + " (copy)",
  };
  s.profiles.push(copy);
  s.activeProfileId = copy.id;
  state.settings = s;
  fillGlobal();
  try {
    await saveSettings(s);
    flashSaved("Profile copied ✓");
  } catch (e) {
    flashSaved("Save failed: " + e.message, true);
  }
}

async function handleProfileDelete() {
  const s = state.settings;
  normalizeProfiles(s);
  if (s.profiles.length <= 1) {
    flashSaved("Can't delete the last profile", true);
    return;
  }
  const cur = activeProfile(s);
  if (!confirm(`Delete connection profile "${cur.name}"?`)) return;
  s.profiles = s.profiles.filter((p) => p.id !== s.activeProfileId);
  s.activeProfileId = s.profiles[0].id;
  normalizeProfiles(s);
  state.settings = s;
  fillGlobal();
  try {
    await saveSettings(s);
    flashSaved("Profile deleted ✓");
  } catch (e) {
    flashSaved("Save failed: " + e.message, true);
  }
}

function collectGlobal() {
  const s = {
    ...state.settings,
    ...collectConnection(),
    maxContextTokens: Number(el.maxContext.value) || 8000,
    autoSummaryThresholdPercent: Number(el.autoThreshold.value) || 70,
    keepRecentMessagesAfterSummary: Number(el.keepN.value) || 10,
    narratorSystemPrompt: el.narratorPrompt.value,
    summarizerSystemPrompt: el.summarizerPrompt.value,
  };
  normalizeProfiles(s);
  const cur = activeProfile(s);
  cur.name = el.profileName.value.trim() || cur.name || "Default";
  mirrorToActiveProfile(s);
  return s;
}

async function handleSaveSettings() {
  try {
    state.settings = collectGlobal();
    await saveSettings(state.settings);
    document.dispatchEvent(new CustomEvent("settings-changed"));
    flashSaved("Saved ✓");
    fillSessionSection(); // plan injection text depends on settings only via session; cheap refresh
    refreshContextIndicator();
  } catch (e) {
    flashSaved("Save failed: " + e.message, true);
  }
}

function flashSaved(text, isError = false) {
  el.savedMsg.textContent = text;
  el.savedMsg.style.color = isError ? "var(--danger)" : "var(--ok)";
  setTimeout(() => { el.savedMsg.textContent = ""; }, 3500);
}

// ---------- this-session settings ----------

async function fillSessionSection() {
  // Skip entirely when the Settings tab is hidden — avoids a getSession() read on
  // every session/message snapshot (each message write touches the session doc).
  const tab = document.getElementById("settings-tab");
  if (tab.classList.contains("hidden")) return;
  if (!state.sessionId) {
    el.sessionTitle.value = "";
    el.sessionPlan.value = "";
    return;
  }
  try {
    const s = await getSession(state.sessionId);
    if (!s) return;
    if (el.sessionTitle.value !== s.title && document.activeElement !== el.sessionTitle) {
      el.sessionTitle.value = s.title ?? "";
    }
    if (document.activeElement !== el.sessionPlan) {
      el.sessionPlan.value = s.longTermPlan ?? "";
    }
  } catch (e) {
    console.error("Failed to load session for settings:", e);
  }
}

async function handleSaveSession() {
  if (!state.sessionId) return;
  try {
    // Single updateDoc write: title + long-term plan together.
    await updateSession(state.sessionId, {
      title: el.sessionTitle.value.trim() || "Untitled",
      longTermPlan: el.sessionPlan.value,
    });
    flashSaved("Session saved ✓");
    refreshContextIndicator();
  } catch (e) {
    flashSaved("Save failed: " + e.message, true);
  }
}

// ---------- import / export ----------

async function handleImport() {
  const file = el.importFile.files[0];
  el.importFile.value = "";
  if (!file) return;
  try {
    flashSaved("Importing…");
    const sessionId = await importSillyTavern(file);
    flashSaved(`Imported ✓`);
    // Importing into a NEW session; select it via full page reload of sidebar listener.
    document.dispatchEvent(new CustomEvent("session-imported", { detail: sessionId }));
    document.getElementById("set-session-title").focus();
  } catch (e) {
    flashSaved("Import failed: " + e.message, true);
  }
}

async function handleExport() {
  if (!state.sessionId) return;
  try {
    await exportSillyTavern(state.sessionId);
  } catch (e) {
    flashSaved("Export failed: " + e.message, true);
  }
}
