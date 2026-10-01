import { state } from "../state.js";
import { DEFAULT_SETTINGS, saveSettings, activeProfile, mirrorToActiveProfile, mirrorFromActiveProfile } from "../settings.js";
import { getSession, updateSession } from "../sessions.js";
import { importSillyTavern, exportSillyTavern } from "../import-export.js";
import { refreshContextIndicator } from "./chat-view.js";

const el = {};
const connectionFields = {
  endpoint: "set-endpoint", apiKey: "set-apikey", modelId: "set-model",
  maxResponseTokens: "set-max-resp", temperature: "set-temperature", topP: "set-top-p",
  frequencyPenalty: "set-frequency-penalty", presencePenalty: "set-presence-penalty",
};
const contextFields = {
  maxContextTokens: "set-max-context", autoSummaryThresholdPercent: "set-auto-threshold",
  keepRecentMessagesAfterSummary: "set-keep-n", summarizerMaxTokens: "set-summarizer-maxtokens",
  summarizerChunkTokens: "set-summarizer-chunk",
};
const samplingRanges = { temperature: [0, 2], topP: [0, 1], frequencyPenalty: [-2, 2], presencePenalty: [-2, 2] };
let draft;
let original;
let panel = "model";
let opener = null;
let sessionOriginal = { title: "", longTermPlan: "" };
let sessionId = null;
let saving = false;

const input = (id) => document.getElementById(id);
const raw = (id) => input(id).value;
const set = (id, value) => { input(id).value = String(value ?? ""); };

export function initSettingsView() {
  Object.assign(el, {
    overlay: input("settings-tab"), content: input("settings-content"), footer: input("settings-footer"),
    message: input("settings-saved-msg"), save: input("btn-save-settings"), saveSession: input("btn-save-session"),
    reset: input("btn-reset-settings"), profiles: input("set-profiles"),
  });
  input("btn-close-settings").addEventListener("click", closeSettingsPopup);
  input("settings-backdrop").addEventListener("click", closeSettingsPopup);
  document.addEventListener("keydown", (event) => {
    if (el.overlay.classList.contains("hidden")) return;
    if (event.key === "Escape") { event.preventDefault(); closeSettingsPopup(); }
    if (event.key !== "Tab") return;
    const focusables = [...el.overlay.querySelectorAll("button, input, select, textarea")]
      .filter((node) => !node.disabled && !node.closest(".hidden") && node.getClientRects().length);
    const first = focusables[0], last = focusables.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  document.querySelectorAll("[data-settings-panel]").forEach((button) =>
    button.addEventListener("click", () => showPanel(button.dataset.settingsPanel)));
  el.profiles.addEventListener("change", () => {
    capture();
    draft.activeProfileId = el.profiles.value;
    mirrorFromActiveProfile(draft);
    renderProfile();
    clearMessage();
  });
  input("set-reasoning-enabled").addEventListener("change", syncOptionalControls);
  input("set-reasoning-mode").addEventListener("change", syncOptionalControls);
  input("set-advanced-enabled").addEventListener("change", syncOptionalControls);
  input("btn-profile-copy").addEventListener("click", () => {
    capture();
    const copy = structuredClone(activeProfile(draft));
    copy.id = crypto.randomUUID();
    copy.name += " (copy)";
    draft.profiles.push(copy);
    draft.activeProfileId = copy.id;
    mirrorFromActiveProfile(draft);
    renderProfile();
  });
  input("btn-profile-delete").addEventListener("click", () => {
    if (draft.profiles.length === 1) return feedback("Keep at least one profile.", true);
    capture();
    const current = activeProfile(draft);
    if (!confirm(`Delete connection profile "${current.name}"?`)) return;
    draft.profiles = draft.profiles.filter((profile) => profile.id !== current.id);
    draft.activeProfileId = draft.profiles[0].id;
    mirrorFromActiveProfile(draft);
    renderProfile();
  });
  el.save.addEventListener("click", handleSaveSettings);
  el.reset.addEventListener("click", resetPanel);
  el.saveSession.addEventListener("click", handleSaveSession);
  input("btn-import-st").addEventListener("click", () => input("file-import-st").click());
  input("file-import-st").addEventListener("change", handleImport);
  input("btn-export-st").addEventListener("click", handleExport);
  document.addEventListener("session-changed", (event) => {
    if (!el.overlay.classList.contains("hidden") && panel === "story" && !sessionDirty()) fillSession(event);
  });
  document.addEventListener("settings-changed", () => {
    if (el.overlay.classList.contains("hidden")) return;
    // Chat quick controls may change saved settings while the popup is open.
    if (!globalDirty()) { original = structuredClone(state.settings); draft = structuredClone(state.settings); renderAll(); }
  });
}

export function openSettingsPopup(trigger = document.activeElement) {
  if (!el.overlay.classList.contains("hidden")) return;
  opener = trigger;
  original = structuredClone(state.settings);
  draft = structuredClone(state.settings);
  el.overlay.classList.remove("hidden");
  el.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("settings-open");
  renderAll();
  capture();
  original = structuredClone(draft);
  showPanel("model");
  input("btn-close-settings").focus();
}

function closeSettingsPopup() {
  if (saving) return;
  capture();
  if ((globalDirty() || sessionDirty() || accountDirty()) && !confirm("Discard unsaved settings changes?")) return;
  el.overlay.classList.add("hidden");
  el.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("settings-open");
  sessionId = null;
  set("set-session-title", ""); set("set-session-plan", "");
  for (const id of ["current-password", "new-password", "confirm-new-password"]) set(id, "");
  clearMessage();
  opener?.focus?.();
}

function globalDirty() { return JSON.stringify(draft) !== JSON.stringify(original); }
function sessionDirty() {
  if (sessionId !== state.sessionId) return false;
  return raw("set-session-title") !== sessionOriginal.title || raw("set-session-plan") !== sessionOriginal.longTermPlan;
}
function accountDirty() {
  return ["current-password", "new-password", "confirm-new-password"].some((id) => raw(id) !== "");
}

function showPanel(name) {
  capture();
  panel = name;
  document.querySelectorAll("[data-settings-panel]").forEach((button) => {
    const selected = button.dataset.settingsPanel === name;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
    if (selected) button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });
  document.querySelectorAll("[data-panel]").forEach((section) => section.classList.toggle("hidden", section.dataset.panel !== name));
  el.content.scrollTop = 0;
  const global = ["model", "context", "prompts"].includes(name);
  el.footer.classList.toggle("hidden", !global && name !== "story");
  el.save.classList.toggle("hidden", !global);
  el.reset.classList.toggle("hidden", !global);
  el.saveSession.classList.toggle("hidden", name !== "story");
  clearMessage();
  if (name === "story") fillSession();
}

function renderAll() {
  renderProfile();
  for (const [key, id] of Object.entries(contextFields)) set(id, draft[key]);
  input("set-auto-summary-enabled").checked = draft.autoSummarizationEnabled === true;
  set("set-narrator-prompt", draft.narratorSystemPrompt);
  set("set-summarizer-prompt", draft.summarizerSystemPrompt);
}
function renderProfile() {
  el.profiles.replaceChildren(...draft.profiles.map((profile) => {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name; return option;
  }));
  el.profiles.value = draft.activeProfileId;
  const profile = activeProfile(draft);
  set("set-profile-name", profile?.name);
  for (const [key, id] of Object.entries(connectionFields)) set(id, profile?.[key] ?? draft[key]);
  input("set-streaming").checked = !!(profile?.streaming ?? draft.streaming);
  const reasoning = profile?.reasoning ?? draft.reasoning ?? DEFAULT_SETTINGS.reasoning;
  input("set-reasoning-enabled").checked = !!reasoning.enabled;
  set("set-reasoning-mode", reasoning.mode);
  set("set-reasoning-effort", reasoning.effort);
  set("set-reasoning-maxtokens", reasoning.maxTokens);
  input("set-advanced-enabled").checked = !!(profile?.advancedParametersEnabled ?? draft.advancedParametersEnabled);
  syncOptionalControls();
}
function syncOptionalControls() {
  const thinking = input("set-reasoning-enabled").checked;
  const maxTokens = thinking && raw("set-reasoning-mode") === "max_tokens";
  input("thinking-options").classList.toggle("hidden", !thinking);
  input("thinking-effort-field").classList.toggle("hidden", !thinking || maxTokens);
  input("thinking-max-field").classList.toggle("hidden", !maxTokens);
  input("set-reasoning-maxtokens").disabled = !maxTokens;
  input("set-reasoning-effort").disabled = !thinking || maxTokens;
  const advanced = input("set-advanced-enabled").checked;
  input("advanced-options").classList.toggle("hidden", !advanced);
  input("set-reasoning-enabled").setAttribute("aria-expanded", String(thinking));
  input("set-advanced-enabled").setAttribute("aria-expanded", String(advanced));
}
function capture() {
  if (!draft) return;
  const profile = activeProfile(draft);
  if (profile) {
    profile.name = raw("set-profile-name").trim() || profile.name || "Default";
    for (const [key, id] of Object.entries(connectionFields)) profile[key] = raw(id).trim();
    profile.streaming = input("set-streaming").checked;
    profile.advancedParametersEnabled = input("set-advanced-enabled").checked;
    profile.reasoning = {
      enabled: input("set-reasoning-enabled").checked,
      mode: raw("set-reasoning-mode"), effort: raw("set-reasoning-effort"),
      maxTokens: raw("set-reasoning-maxtokens").trim(),
    };
    mirrorFromActiveProfile(draft);
  }
  for (const [key, id] of Object.entries(contextFields)) draft[key] = raw(id).trim();
  draft.autoSummarizationEnabled = input("set-auto-summary-enabled").checked;
  draft.narratorSystemPrompt = raw("set-narrator-prompt");
  draft.summarizerSystemPrompt = raw("set-summarizer-prompt");
}

function resetPanel() {
  capture();
  if (panel === "model") {
    const profile = activeProfile(draft);
    for (const key of ["streaming", "maxResponseTokens", "advancedParametersEnabled", "temperature", "topP", "frequencyPenalty", "presencePenalty"])
      profile[key] = DEFAULT_SETTINGS[key];
    profile.reasoning = structuredClone(DEFAULT_SETTINGS.reasoning);
    mirrorFromActiveProfile(draft);
    renderProfile();
  } else if (panel === "context") {
    for (const [key, id] of Object.entries(contextFields)) { draft[key] = DEFAULT_SETTINGS[key]; set(id, draft[key]); }
    draft.autoSummarizationEnabled = DEFAULT_SETTINGS.autoSummarizationEnabled;
    input("set-auto-summary-enabled").checked = draft.autoSummarizationEnabled;
  } else if (panel === "prompts") {
    draft.narratorSystemPrompt = DEFAULT_SETTINGS.narratorSystemPrompt;
    draft.summarizerSystemPrompt = DEFAULT_SETTINGS.summarizerSystemPrompt;
    set("set-narrator-prompt", draft.narratorSystemPrompt);
    set("set-summarizer-prompt", draft.summarizerSystemPrompt);
  }
  feedback("Defaults ready. Save to apply.");
}

function numberField(value, id, min, max, optional = false) {
  const text = String(value ?? "").trim();
  if (optional && text === "") return null;
  const number = Number(text);
  const valid = text !== "" && Number.isFinite(number) && number >= min && number <= max &&
    (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text));
  if (!valid) throw new Error(`${input(id).closest("label").firstChild.textContent.trim()}: enter a number from ${min} to ${max}.`);
  return number;
}
function integerField(value, id) {
  const field = input(id);
  const min = Number(field.dataset.min), max = field.dataset.max ? Number(field.dataset.max) : Number.MAX_SAFE_INTEGER;
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) > max)
    throw new Error(`${field.closest("label").firstChild.textContent.trim()}: enter a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ""}.`);
  return Number(text);
}
function validatedDraft() {
  const result = structuredClone(draft);
  for (const profile of result.profiles) {
    for (const [key, id] of Object.entries(connectionFields)) {
      if (key in samplingRanges && profile.advancedParametersEnabled) {
        const [min, max] = samplingRanges[key];
        profile[key] = numberField(profile[key], id, min, max, true);
      } else if (key in samplingRanges && String(profile[key] ?? "").trim() === "") {
        profile[key] = null;
      }
    }
    profile.maxResponseTokens = integerField(profile.maxResponseTokens, "set-max-resp");
    if (profile.reasoning.enabled && profile.reasoning.mode === "max_tokens") {
      profile.reasoning.maxTokens = integerField(profile.reasoning.maxTokens, "set-reasoning-maxtokens");
    }
    if (profile.endpoint && !/^https?:\/\//i.test(profile.endpoint)) throw new Error("Endpoint URL must start with http:// or https://.");
  }
  for (const [key, id] of Object.entries(contextFields)) result[key] = integerField(result[key], id);
  mirrorFromActiveProfile(result);
  if (result.maxResponseTokens >= result.maxContextTokens) throw new Error("Max context tokens must exceed max response tokens.");
  return result;
}
async function handleSaveSettings() {
  if (saving) return;
  capture();
  let validated;
  try { validated = validatedDraft(); }
  catch (error) { feedback(error.message, true); return; }
  saving = true; el.save.disabled = true;
  try {
    await saveSettings(validated);
    original = structuredClone(state.settings);
    draft = structuredClone(state.settings);
    renderAll();
    capture();
    original = structuredClone(draft);
    feedback("Saved ✓");
    refreshContextIndicator();
  } catch (error) { feedback("Save failed: " + error.message, true); }
  finally { saving = false; el.save.disabled = false; }
}
function feedback(message, error = false) {
  el.message.textContent = message;
  el.message.style.color = error ? "var(--danger)" : "var(--ok)";
}
function clearMessage() { if (el.message) el.message.textContent = ""; }

async function fillSession(event) {
  if (el.overlay.classList.contains("hidden") || !state.sessionId) {
    sessionId = state.sessionId;
    sessionOriginal = { title: "", longTermPlan: "" };
    set("set-session-title", ""); set("set-session-plan", "");
    return;
  }
  const requestedId = state.sessionId;
  if (sessionId !== requestedId) {
    sessionId = requestedId;
    sessionOriginal = { title: "", longTermPlan: "" };
    set("set-session-title", ""); set("set-session-plan", "");
  } else if (sessionDirty()) return;
  try {
    const session = event?.detail?.sessionId === requestedId ? event.detail.session : await getSession(requestedId);
    if (requestedId !== state.sessionId || sessionDirty()) return;
    sessionId = requestedId;
    sessionOriginal = { title: session?.title ?? "", longTermPlan: session?.longTermPlan ?? "" };
    set("set-session-title", sessionOriginal.title);
    set("set-session-plan", sessionOriginal.longTermPlan);
  } catch (error) { feedback("Could not load story: " + error.message, true); }
}
async function handleSaveSession() {
  if (!state.sessionId) return feedback("Select a story first.", true);
  if (state.busy) return feedback("Wait for the current reply or summary.", true);
  if (saving) return;
  saving = true; el.saveSession.disabled = true;
  try {
    const title = raw("set-session-title").trim() || "Untitled";
    const longTermPlan = raw("set-session-plan");
    await updateSession(state.sessionId, { title, longTermPlan });
    sessionOriginal = { title, longTermPlan };
    set("set-session-title", title);
    feedback("Session saved ✓");
    refreshContextIndicator();
  } catch (error) { feedback("Save failed: " + error.message, true); }
  finally { saving = false; el.saveSession.disabled = false; }
}
async function handleImport() {
  const file = input("file-import-st").files[0];
  input("file-import-st").value = "";
  if (!file) return;
  try {
    feedback("Importing…");
    const id = await importSillyTavern(file);
    document.dispatchEvent(new CustomEvent("session-imported", { detail: id }));
    showPanel("story");
    feedback("Imported ✓");
    input("set-session-title").focus();
  } catch (error) { feedback("Import failed: " + error.message, true); }
}
async function handleExport() {
  if (!state.sessionId) return feedback("Select a story first.", true);
  try { await exportSillyTavern(state.sessionId); }
  catch (error) { feedback("Export failed: " + error.message, true); }
}
