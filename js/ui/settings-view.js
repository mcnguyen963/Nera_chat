import { loadRewriteDefaultPrompt } from "../rewrite.js";
import { vibrationSupport } from "../stream-vibration.js";
import { state } from "../state.js";
import { DEFAULT_SETTINGS, saveSettings, activeProfile, mirrorToActiveProfile, mirrorFromActiveProfile } from "../settings.js";
import { getSession, updateSession } from "../sessions.js";
import { importSillyTavern, exportSillyTavern, exportFullBackup } from "../import-export.js";
import { refreshContextIndicator, getStoryPrivateNote, saveStoryPrivateNote, syncActiveSession } from "./chat-view.js";

import { loadPetCatalog } from "./pet-view.js";

const el = {};
const connectionFields = {
  endpoint: "set-endpoint", apiKey: "set-apikey", modelId: "set-model",
  maxResponseTokens: "set-max-resp", temperature: "set-temperature", topP: "set-top-p",
  modelContextTokens: "set-model-context",
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
let sessionOriginal = { title: "", longTermPlan: "", allowLlmPlanUpdates: false };
let sessionId = null;
let sessionReady = false;
let noteOriginal = { sessionId: null, messageId: null, order: null, text: "" };
let saving = false;
let petChoicesReady = false;
let petCatalog = [];
let petLoadRequest = 0;
let rewritePromptRequest = 0;
let rewriteDefaultPrompt = null;

const input = (id) => document.getElementById(id);
const raw = (id) => input(id).value;
const set = (id, value) => { input(id).value = String(value ?? ""); };

export function initSettingsView() {
  input("stream-vibration-help").hidden = vibrationSupport() !== "unsupported";
  Object.assign(el, {
    overlay: input("settings-tab"), content: input("settings-content"), footer: input("settings-footer"),
    message: input("settings-saved-msg"), save: input("btn-save-settings"), saveSession: input("btn-save-session"),
    reset: input("btn-reset-settings"), profiles: input("set-profiles"),
    petChoices: input("set-pet-choices"),
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
  el.petChoices.addEventListener("change", () => { capture(); clearMessage(); });
  input("set-pet-movement").addEventListener("change", () => { capture(); clearMessage(); });
  input("btn-restore-pet").addEventListener("click", () => document.dispatchEvent(new CustomEvent("pet-restore")));
  document.addEventListener("pet-settings-open", (event) => openSettingsPopup(event.detail?.trigger, { panel: "pets" }));
  input("btn-reset-rewrite-prompt").addEventListener("click", () => {
    draft.rewriteSystemPrompt = null;
    renderRewritePrompt();
    clearMessage();
  });
  el.save.addEventListener("click", handleSaveSettings);
  el.reset.addEventListener("click", resetPanel);
  el.saveSession.addEventListener("click", handleSaveSession);
  input("btn-import-st").addEventListener("click", () => input("file-import-st").click());
  input("file-import-st").addEventListener("change", handleImport);
  input("btn-export-st").addEventListener("click", handleExport);
  input("btn-export-full").addEventListener("click", async () => {
    if (!state.sessionId) return feedback("Select a story first.", true);
    if (state.busy) return feedback("Finish the current reply or summary before exporting.", true);
    const button = input("btn-export-full");
    if (button.disabled) return;
    button.disabled = true;
    try { await exportFullBackup(state.sessionId); feedback("Full backup exported ✓"); }
    catch (error) { feedback("Export failed: " + error.message, true); }
    finally { button.disabled = false; }
  });
  document.addEventListener("session-changed", (event) => {
    if (!el.overlay.classList.contains("hidden") && panel === "story" && !sessionDirty()) fillSession(event);
  });
  document.addEventListener("story-private-note-changed", fillPrivateNote);
  document.addEventListener("chat-busy-changed", syncStoryControls);
  document.addEventListener("settings-changed", () => {
    if (el.overlay.classList.contains("hidden")) return;
    // Chat quick controls may change saved settings while the popup is open.
    if (!globalDirty()) { original = structuredClone(state.settings); draft = structuredClone(state.settings); renderAll(); }
  });
}

export function openSettingsPopup(trigger = document.activeElement, options = {}) {
  if (!el.overlay.classList.contains("hidden")) return;
  opener = trigger;
  original = structuredClone(state.settings);
  draft = structuredClone(state.settings);
  petChoicesReady = false;
  el.overlay.classList.remove("hidden");
  el.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("settings-open");
  renderAll();
  capture();
  original = structuredClone(draft);
  showPanel(options.panel === "pets" ? "pets" : "model");
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
  sessionReady = false;
  noteOriginal = { sessionId: null, messageId: null, order: null, text: "" };
  set("set-session-private-note", "");
  set("set-session-title", ""); set("set-session-plan", "");
  for (const id of ["current-password", "new-password", "confirm-new-password"]) set(id, "");
  clearMessage();
  opener?.focus?.();
}

function globalDirty() { return JSON.stringify(draft) !== JSON.stringify(original); }
function sessionDirty() {
  if (sessionId !== state.sessionId) return false;
  return raw("set-session-title") !== sessionOriginal.title ||
    raw("set-session-plan") !== sessionOriginal.longTermPlan ||
    privateNoteDirty() ||
    input("set-allow-llm-plan-updates").checked !== sessionOriginal.allowLlmPlanUpdates;
}
function privateNoteDirty() {
  return noteOriginal.sessionId === state.sessionId && raw("set-session-private-note") !== noteOriginal.text;
}

function syncStoryControls() {
  el.saveSession.disabled = saving || state.busy || !sessionReady || sessionId !== state.sessionId || !state.sessionId;
  for (const id of ["set-session-title", "set-session-plan", "set-allow-llm-plan-updates"]) {
    input(id).disabled = el.saveSession.disabled;
  }
  input("set-session-private-note").disabled = saving || state.busy || !sessionReady ||
    noteOriginal.sessionId !== state.sessionId || !noteOriginal.messageId;
}

function fillPrivateNote() {
  if (el.overlay.classList.contains("hidden") || panel !== "story" || saving) return;
  if (privateNoteDirty()) return;
  const current = getStoryPrivateNote();
  noteOriginal = {
    sessionId: current.sessionId, messageId: current.message?.id ?? null,
    order: current.message?.order ?? null, text: current.message?.planThread ?? "",
  };
  set("set-session-private-note", noteOriginal.text);
  input("session-private-note-help").textContent = current.message
    ? "The latest reply's saved private note, kept for reference. It is excluded from model context."
    : "The private note will be available after the model's first reply.";
  syncStoryControls();
}
function accountDirty() {
  return ["current-password", "new-password", "confirm-new-password"].some((id) => raw(id) !== "");
}

function showPanel(name) {
  capture();
  panel = name;
  petChoicesReady = false;
  const petRequest = ++petLoadRequest;
  document.querySelectorAll("[data-settings-panel]").forEach((button) => {
    const selected = button.dataset.settingsPanel === name;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
    if (selected) button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });
  document.querySelectorAll("[data-panel]").forEach((section) => section.classList.toggle("hidden", section.dataset.panel !== name));
  if (name === "pets") {
    el.petChoices.textContent = "Loading pets…";
    void loadPetCatalog().then((pets) => {
      if (petRequest !== petLoadRequest || panel !== "pets" || el.overlay.classList.contains("hidden")) return;
      petCatalog = pets;
      renderPetChoices(draft.petCharacterIds);
    }).catch((error) => {
      if (petRequest === petLoadRequest && panel === "pets")
        el.petChoices.textContent = error.message || "Could not load pets.";
    });
  }
  el.content.scrollTop = 0;
  const global = ["model", "context", "pets", "prompts"].includes(name);
  el.footer.classList.toggle("hidden", !global && name !== "story");
  el.save.classList.toggle("hidden", !global);
  el.reset.classList.toggle("hidden", !global);
  el.saveSession.classList.toggle("hidden", name !== "story");
  clearMessage();
  if (name === "story") fillSession();
}

function renderAll() {
  set("set-pet-movement", draft.petMovement === "stay" ? "stay" : "roam");
  if (petChoicesReady && panel === "pets") renderPetChoices(draft.petCharacterIds);
  renderProfile();
  for (const [key, id] of Object.entries(contextFields)) set(id, draft[key]);
  input("set-auto-summary-enabled").checked = draft.autoSummarizationEnabled === true;
  set("set-narrator-prompt", draft.narratorSystemPrompt);
  set("set-summarizer-prompt", draft.summarizerSystemPrompt);
  set("set-rewrite-n", draft.rewriteRecentMessages ?? 10);
  set("set-stream-vibration", draft.streamVibrationMode ?? "spaces");
  renderRewritePrompt();
}
function renderRewritePrompt() {
  const request = ++rewritePromptRequest;
  const field = input("set-rewrite-prompt");
  const help = input("rewrite-prompt-help");
  if (draft.rewriteSystemPrompt != null) {
    field.disabled = false;
    field.value = draft.rewriteSystemPrompt;
    help.textContent = "Your saved prompt overrides rewrite_default_prompt.md.";
    return;
  }
  field.disabled = true;
  field.value = rewriteDefaultPrompt ?? "";
  help.textContent = "Loading rewrite_default_prompt.md…";
  void loadRewriteDefaultPrompt().then((prompt) => {
    if (request !== rewritePromptRequest) return;
    rewriteDefaultPrompt = prompt;
    field.value = prompt;
    field.disabled = false;
    help.textContent = "Using rewrite_default_prompt.md. Edit here to save a custom prompt.";
  }).catch((error) => {
    if (request === rewritePromptRequest) help.textContent = error.message + " Click Use default rewrite prompt to retry.";
  });
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
function renderPetChoices(selectedIds = []) {
  petChoicesReady = true;
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const choices = petCatalog.map((pet) => {
    const label = document.createElement("label");
    label.className = "pet-choice";
    const preview = document.createElement("span");
    preview.className = "pet-choice-preview";
    preview.setAttribute("aria-hidden", "true");
    preview.style.backgroundImage = `url("${pet.image}")`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = pet.id;
    checkbox.checked = selected.has(pet.id);
    label.append(checkbox, preview, document.createTextNode(pet.name));
    return label;
  });
  if (!choices.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No pet sheets found in resources/pets.";
    choices.push(empty);
  }
  if ([...selected].some((id) => !petCatalog.some((pet) => pet.id === id))) {
    const missing = document.createElement("p");
    missing.className = "muted";
    missing.textContent = "A selected pet is no longer available. Saving will remove it.";
    choices.push(missing);
  }
  el.petChoices.replaceChildren(...choices);
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
  draft.petMovement = raw("set-pet-movement") === "stay" ? "stay" : "roam";
  if (petChoicesReady) draft.petCharacterIds = [...el.petChoices.querySelectorAll("input:checked")].map((checkbox) => checkbox.value);
  draft.narratorSystemPrompt = raw("set-narrator-prompt");
  draft.summarizerSystemPrompt = raw("set-summarizer-prompt");
  draft.rewriteRecentMessages = raw("set-rewrite-n").trim();
  draft.streamVibrationMode = raw("set-stream-vibration");
  if (!input("set-rewrite-prompt").disabled) {
    const prompt = raw("set-rewrite-prompt");
    draft.rewriteSystemPrompt = draft.rewriteSystemPrompt == null && prompt === rewriteDefaultPrompt ? null : prompt;
  }
}

function resetPanel() {
  capture();
  if (panel === "model") {
    const profile = activeProfile(draft);
    for (const key of ["streaming", "maxResponseTokens", "advancedParametersEnabled", "temperature", "topP", "frequencyPenalty", "presencePenalty"])
      profile[key] = DEFAULT_SETTINGS[key];
    profile.reasoning = structuredClone(DEFAULT_SETTINGS.reasoning);
    mirrorFromActiveProfile(draft);
    draft.streamVibrationMode = DEFAULT_SETTINGS.streamVibrationMode;
    set("set-stream-vibration", draft.streamVibrationMode);
    renderProfile();
  } else if (panel === "context") {
    for (const [key, id] of Object.entries(contextFields)) { draft[key] = DEFAULT_SETTINGS[key]; set(id, draft[key]); }
    draft.autoSummarizationEnabled = DEFAULT_SETTINGS.autoSummarizationEnabled;
    input("set-auto-summary-enabled").checked = draft.autoSummarizationEnabled;
  } else if (panel === "pets") {
    draft.petCharacterIds = structuredClone(DEFAULT_SETTINGS.petCharacterIds);
    draft.petMovement = DEFAULT_SETTINGS.petMovement;
    set("set-pet-movement", draft.petMovement);
    renderPetChoices(draft.petCharacterIds);
  } else if (panel === "prompts") {
    draft.rewriteRecentMessages = DEFAULT_SETTINGS.rewriteRecentMessages;
    draft.rewriteSystemPrompt = null;
    set("set-rewrite-n", draft.rewriteRecentMessages);
    renderRewritePrompt();
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
    profile.modelContextTokens = String(profile.modelContextTokens ?? "").trim()
      ? integerField(profile.modelContextTokens, "set-model-context") : null;
    if (profile.modelContextTokens != null && profile.maxResponseTokens >= profile.modelContextTokens) {
      throw new Error("Max response tokens must be lower than the model's total context window.");
    }
    if (profile.reasoning.enabled && profile.reasoning.mode === "max_tokens") {
      profile.reasoning.maxTokens = integerField(profile.reasoning.maxTokens, "set-reasoning-maxtokens");
      if (profile.reasoning.maxTokens >= profile.maxResponseTokens) {
        throw new Error("Reasoning max tokens must be lower than Max response tokens (reasoning counts toward the response limit).");
      }
    }
    if (profile.endpoint && !/^https?:\/\//i.test(profile.endpoint)) throw new Error("Endpoint URL must start with http:// or https://.");
  }
  for (const [key, id] of Object.entries(contextFields)) result[key] = integerField(result[key], id);
  result.rewriteRecentMessages = integerField(result.rewriteRecentMessages, "set-rewrite-n");
  if (!["off", "speed", "spaces"].includes(result.streamVibrationMode)) throw new Error("Choose a valid vibration mode.");
  if (result.rewriteSystemPrompt != null && !result.rewriteSystemPrompt.trim()) throw new Error("Rewrite system prompt cannot be empty. Use the default or enter a prompt.");
  mirrorFromActiveProfile(result);
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
  } catch (error) {
    if (error.code === "settings-reloaded") {
      original = structuredClone(state.settings);
      draft = structuredClone(state.settings);
      renderAll();
    }
    feedback("Save failed: " + error.message, true);
  }
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
    sessionReady = false;
    sessionOriginal = { title: "", longTermPlan: "", allowLlmPlanUpdates: false };
    set("set-session-title", ""); set("set-session-plan", "");
    input("set-allow-llm-plan-updates").checked = false;
    fillPrivateNote();
    syncStoryControls();
    return;
  }
  const requestedId = state.sessionId;
  if (sessionId !== requestedId) {
    sessionId = requestedId;
    sessionReady = false;
    sessionOriginal = { title: "", longTermPlan: "", allowLlmPlanUpdates: false };
    set("set-session-title", ""); set("set-session-plan", "");
    input("set-allow-llm-plan-updates").checked = false;
  } else if (sessionDirty()) return;
  fillPrivateNote();
  syncStoryControls();
  try {
    const session = event?.detail?.sessionId === requestedId ? event.detail.session : await getSession(requestedId);
    if (requestedId !== state.sessionId || sessionId !== requestedId || el.overlay.classList.contains("hidden") || sessionDirty()) return;
    sessionId = requestedId;
    sessionOriginal = {
      title: session?.title ?? "", longTermPlan: session?.longTermPlan ?? "",
      allowLlmPlanUpdates: session?.allowLlmPlanUpdates === true,
    };
    set("set-session-title", sessionOriginal.title);
    set("set-session-plan", sessionOriginal.longTermPlan);
    input("set-allow-llm-plan-updates").checked = sessionOriginal.allowLlmPlanUpdates;
    sessionReady = Boolean(session);
    fillPrivateNote();
    syncStoryControls();
  } catch (error) { feedback("Could not load story: " + error.message, true); }
}
async function handleSaveSession() {
  if (!state.sessionId) return feedback("Select a story first.", true);
  if (!sessionReady || sessionId !== state.sessionId) return feedback("Wait for this story to load.", true);
  if (state.busy) return feedback("Wait for the current reply or summary.", true);
  if (saving) return;
  const requestedId = state.sessionId;
  const noteChanged = privateNoteDirty();
  const noteText = raw("set-session-private-note");
  saving = true; syncStoryControls();
  try {
    const title = raw("set-session-title").trim() || "Untitled";
    const longTermPlan = raw("set-session-plan");
    const allowLlmPlanUpdates = input("set-allow-llm-plan-updates").checked;
    const patch = { title, longTermPlan, allowLlmPlanUpdates };
    if (noteChanged) {
      await saveStoryPrivateNote(requestedId, noteOriginal.messageId, noteOriginal.order, noteText, patch);
    } else {
      await updateSession(requestedId, patch);
      syncActiveSession({ id: requestedId, ...patch });
    }
    if (requestedId !== state.sessionId) return;
    sessionOriginal = { title, longTermPlan, allowLlmPlanUpdates };
    if (noteChanged) noteOriginal = { ...noteOriginal, text: noteText };
    set("set-session-title", title);
    feedback("Session saved ✓");
    refreshContextIndicator();
  } catch (error) { feedback("Save failed: " + error.message, true); }
  finally { saving = false; fillPrivateNote(); syncStoryControls(); }
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
