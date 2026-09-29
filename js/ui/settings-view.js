import { state } from "../state.js";
import { DEFAULT_SETTINGS, saveSettings, activeProfile, mirrorToActiveProfile, mirrorFromActiveProfile } from "../settings.js";
import { getSession, updateSession } from "../sessions.js";
import { importSillyTavern, exportSillyTavern } from "../import-export.js";
import { refreshContextIndicator, setSession, forgetChatSession } from "./chat-view.js";
import { PET_CATALOG } from "./pet-view.js";

const el = {};
const connectionFields = {
  endpoint: "set-endpoint", apiKey: "set-apikey", modelId: "set-model",
  maxResponseTokens: "set-max-resp", temperature: "set-temperature", topP: "set-top-p",
  frequencyPenalty: "set-frequency-penalty", presencePenalty: "set-presence-penalty",
};
const contextFields = {
  maxContextTokens: "set-max-context", autoSummaryThresholdPercent: "set-auto-threshold",
  keepRecentMessagesAfterSummary: "set-keep-n", summarizerMaxTokens: "set-summarizer-maxtokens",
  summarizerChunkTokens: "set-summarizer-chunk", chatRecallBudgetTokens: "set-recall-budget",
};
const samplingRanges = { temperature: [0, 2], topP: [0, 1], frequencyPenalty: [-2, 2], presencePenalty: [-2, 2] };
let draft;
let original;
let panel = "model";
let opener = null;
let sessionOriginal = { title: "", longTermPlan: "", shortMemory: "", nextOrder: 0 };
let sessionId = null;
let saving = false;
let petChoicesReady = false;

const input = (id) => document.getElementById(id);
const raw = (id) => input(id).value;
const set = (id, value) => { input(id).value = String(value ?? ""); };

export function initSettingsView() {
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
  input("set-chat-recall").addEventListener("change", syncMemoryControls);
  input("set-semantic-search").addEventListener("change", syncMemoryControls);
  el.petChoices.addEventListener("change", () => { capture(); clearMessage(); });
  input("btn-clear-short-memory").addEventListener("click", () => set("set-session-memory", ""));
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
  input("btn-enable-continuity").addEventListener("click", async () => {
    if (!state.sessionId || state.busy || saving) return;
    const button = input("btn-enable-continuity");
    button.disabled = true;
    try {
      const id = state.sessionId;
      const { enableContinuity } = await import("../continuity/runtime.js");
      await enableContinuity(id);
      setSession(null, { skipCacheSave: true });
      forgetChatSession(id);
      setSession(id, { fresh: true });
      sessionOriginal.continuityEnabled = true;
      setContinuityStoryControls(true, 0);
      await fillSession();
      feedback("Character continuity enabled for this story.");
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  input("btn-view-continuity").addEventListener("click", async () => {
    if (!state.sessionId) return;
    const preview = input("continuity-state-preview");
    preview.hidden = false;
    preview.textContent = "Loading saved state…";
    try {
      const current = await getSession(state.sessionId);
      if (!current?.continuityEnabled) throw new Error("Character continuity is not active.");
      const { storyStore } = await import("../continuity/runtime.js");
      const { state: story } = await storyStore(state.sessionId).load(current.continuityBranchId || "main");
      preview.textContent = JSON.stringify({ revision: story.revision, records: story.records }, null, 2);
    } catch (error) { preview.textContent = "Could not load state: " + error.message; }
  });
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
  petChoicesReady = false;
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
  set("set-session-title", ""); set("set-session-plan", ""); set("set-session-memory", "");
  for (const id of ["current-password", "new-password", "confirm-new-password"]) set(id, "");
  clearMessage();
  opener?.focus?.();
}

function globalDirty() { return JSON.stringify(draft) !== JSON.stringify(original); }
function sessionDirty() {
  if (sessionId !== state.sessionId) return false;
  return raw("set-session-title") !== sessionOriginal.title || raw("set-session-plan") !== sessionOriginal.longTermPlan ||
    raw("set-session-memory") !== sessionOriginal.shortMemory;
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
  if (name === "pets") renderPetChoices(draft.petCharacterIds);
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
  renderProfile();
  for (const [key, id] of Object.entries(contextFields)) set(id, draft[key]);
  input("set-auto-summarization").checked = draft.autoSummarizationEnabled === true;
  input("set-chat-recall").checked = draft.chatRecallEnabled === true;
  input("set-semantic-search").checked = draft.semanticSearchEnabled === true;
  input("set-short-memory").checked = draft.shortMemoryEnabled === true;
  if (petChoicesReady && panel === "pets") renderPetChoices(draft.petCharacterIds);
  set("set-embedding-endpoint", draft.embeddingEndpoint);
  set("set-embedding-key", draft.embeddingApiKey);
  set("set-embedding-model", draft.embeddingModelId);
  syncMemoryControls();
  set("set-narrator-prompt", draft.narratorSystemPrompt);
  set("set-continuity-style", draft.continuityStylePrompt);
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
function renderPetChoices(selectedIds = []) {
  petChoicesReady = true;
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  el.petChoices.replaceChildren(...PET_CATALOG.map((pet) => {
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
  }));
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
function syncMemoryControls() {
  const recall = input("set-chat-recall").checked;
  const semantic = recall && input("set-semantic-search").checked;
  input("set-recall-budget").disabled = !recall;
  input("set-semantic-search").disabled = !recall;
  for (const id of ["set-embedding-endpoint", "set-embedding-key", "set-embedding-model"])
    input(id).disabled = !semantic;
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
  draft.autoSummarizationEnabled = input("set-auto-summarization").checked;
  draft.chatRecallEnabled = input("set-chat-recall").checked;
  draft.semanticSearchEnabled = input("set-semantic-search").checked;
  draft.shortMemoryEnabled = input("set-short-memory").checked;
  if (petChoicesReady) draft.petCharacterIds = [...el.petChoices.querySelectorAll("input:checked")].map((checkbox) => checkbox.value);
  draft.embeddingEndpoint = raw("set-embedding-endpoint").trim();
  draft.embeddingApiKey = raw("set-embedding-key").trim();
  draft.embeddingModelId = raw("set-embedding-model").trim();
  draft.narratorSystemPrompt = raw("set-narrator-prompt");
  draft.continuityStylePrompt = raw("set-continuity-style");
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
    input("set-auto-summarization").checked = draft.autoSummarizationEnabled;
    for (const key of ["chatRecallEnabled", "semanticSearchEnabled", "shortMemoryEnabled"]) draft[key] = DEFAULT_SETTINGS[key];
    for (const key of ["embeddingEndpoint", "embeddingApiKey", "embeddingModelId"]) draft[key] = DEFAULT_SETTINGS[key];
    input("set-chat-recall").checked = false;
    input("set-semantic-search").checked = false;
    input("set-short-memory").checked = false;
    for (const id of ["set-embedding-endpoint", "set-embedding-key", "set-embedding-model"]) set(id, "");
    syncMemoryControls();
  } else if (panel === "pets") {
    draft.petCharacterIds = structuredClone(DEFAULT_SETTINGS.petCharacterIds);
    renderPetChoices(draft.petCharacterIds);
  } else if (panel === "prompts") {
    draft.narratorSystemPrompt = DEFAULT_SETTINGS.narratorSystemPrompt;
    draft.continuityStylePrompt = DEFAULT_SETTINGS.continuityStylePrompt;
    draft.summarizerSystemPrompt = DEFAULT_SETTINGS.summarizerSystemPrompt;
    set("set-narrator-prompt", draft.narratorSystemPrompt);
    set("set-continuity-style", draft.continuityStylePrompt);
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
  if (result.chatRecallEnabled && result.semanticSearchEnabled) {
    if (!/^https?:\/\//i.test(result.embeddingEndpoint)) throw new Error("Embedding endpoint must start with http:// or https://.");
    if (!result.embeddingApiKey || !result.embeddingModelId) throw new Error("Enter an embedding API key and model ID for semantic search.");
  }
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
    const recallJustEnabled = original.chatRecallEnabled !== true && validated.chatRecallEnabled === true;
    await saveSettings(validated);
    if (recallJustEnabled) {
      try {
        const { clearRecallIndex } = await import("../chat-recall.js");
        await clearRecallIndex();
      } catch { /* A fresh index will be built when recall runs. */ }
    }
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

function setContinuityStoryControls(enabled, nextOrder) {
  input("btn-enable-continuity").hidden = enabled || nextOrder > 0;
  input("btn-view-continuity").hidden = !enabled;
  input("continuity-state-preview").hidden = true;
  input("continuity-setting-status").textContent = enabled ? "Character continuity is active" :
    nextOrder > 0 ? "Existing stories need a reviewed migration before continuity can be enabled." : "";
  input("set-session-plan").disabled = enabled;
  input("set-session-memory").disabled = enabled;
  input("btn-clear-short-memory").disabled = enabled;
}

async function fillSession(event) {
  if (el.overlay.classList.contains("hidden") || !state.sessionId) {
    sessionId = state.sessionId;
    sessionOriginal = { title: "", longTermPlan: "", shortMemory: "", nextOrder: 0 };
    set("set-session-title", ""); set("set-session-plan", ""); set("set-session-memory", "");
    setContinuityStoryControls(false, 0);
    input("btn-enable-continuity").hidden = true;
    return;
  }
  const requestedId = state.sessionId;
  if (sessionId !== requestedId) {
    sessionId = requestedId;
    sessionOriginal = { title: "", longTermPlan: "", shortMemory: "", nextOrder: 0 };
    set("set-session-title", ""); set("set-session-plan", ""); set("set-session-memory", "");
    setContinuityStoryControls(false, 0);
    input("btn-enable-continuity").hidden = true;
  } else if (sessionDirty()) return;
  try {
    const session = event?.detail?.sessionId === requestedId ? event.detail.session : await getSession(requestedId);
    if (requestedId !== state.sessionId || sessionDirty()) return;
    sessionId = requestedId;
    sessionOriginal = { title: session?.title ?? "", longTermPlan: session?.longTermPlan ?? "",
      shortMemory: session?.shortMemory ?? "", nextOrder: session?.nextOrder ?? 0,
      continuityEnabled: session?.continuityEnabled === true };
    set("set-session-title", sessionOriginal.title);
    set("set-session-plan", sessionOriginal.longTermPlan);
    set("set-session-memory", sessionOriginal.shortMemory);
    setContinuityStoryControls(sessionOriginal.continuityEnabled, sessionOriginal.nextOrder);
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
    const shortMemory = raw("set-session-memory").trim();
    if (!sessionOriginal.continuityEnabled && shortMemory.length > 6000)
      throw new Error("Short memory must be under 6,000 characters.");
    if (!sessionOriginal.continuityEnabled && shortMemory !== sessionOriginal.shortMemory && shortMemory) {
      const { countTokens } = await import("../tokenizer.js");
      if (await countTokens(shortMemory) > 1200) throw new Error("Short memory must be under 1,200 tokens.");
    }
    await updateSession(state.sessionId, sessionOriginal.continuityEnabled ? { title } : { title, longTermPlan,
      ...(shortMemory !== sessionOriginal.shortMemory
        ? { shortMemory, shortMemoryThroughOrder: sessionOriginal.nextOrder } : {}) });
    sessionOriginal = { ...sessionOriginal, title, longTermPlan, shortMemory };
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
