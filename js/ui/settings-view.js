import { state } from "../state.js";
import { DEFAULT_SETTINGS, saveSettings, activeProfile, mirrorToActiveProfile, mirrorFromActiveProfile } from "../settings.js";
import { getSession, updateSession } from "../sessions.js";
import { importSillyTavern, exportSillyTavern } from "../import-export.js";
import { refreshContextIndicator, setSession, forgetChatSession } from "./chat-view.js";
import { loadPetCatalog } from "./pet-view.js";

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
let petCatalog = [];
let petLoadRequest = 0;
let preparedMigration = null;
let migrationRecovery = null;
let editorState = null;
let editorPending = null;
let editorDirty = false;
let editorRows = [];

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
  input("set-balanced-thinking").addEventListener("change", syncBalancedControls);
  input("btn-save-balanced-settings").addEventListener("click", handleSaveSettings);
  input("set-reasoning-enabled").addEventListener("change", syncOptionalControls);
  input("set-reasoning-mode").addEventListener("change", syncOptionalControls);
  input("set-advanced-enabled").addEventListener("change", syncOptionalControls);
  input("set-chat-recall").addEventListener("change", syncMemoryControls);
  input("set-semantic-search").addEventListener("change", syncMemoryControls);
  el.petChoices.addEventListener("change", () => { capture(); clearMessage(); });
  input("set-pet-movement").addEventListener("change", () => { capture(); clearMessage(); });
  input("btn-restore-pet").addEventListener("click", () => document.dispatchEvent(new CustomEvent("pet-restore")));
  document.addEventListener("pet-settings-open", (event) => openSettingsPopup(event.detail?.trigger, { panel: "pets" }));
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
      preview.textContent = JSON.stringify({ revision: story.revision,
        records: story.records, events: story.events }, null, 2);
    } catch (error) { preview.textContent = "Could not load state: " + error.message; }
  });
  input("set-continuity-mode").addEventListener("change", async () => {
    if (!state.sessionId || saving || state.busy) return;
    const id = state.sessionId;
    const value = raw("set-continuity-mode");
    syncBalancedControls();
    try {
      if (!sessionOriginal.continuityEnabled || !["reviewed", "saver", "balanced"].includes(value))
        throw new Error("Select a continuity story and a valid mode.");
      await updateSession(id, { continuityMode: value });
      sessionOriginal.continuityMode = value;
      feedback(`${{ saver: "Saver", balanced: "Balanced", reviewed: "Reviewed" }[value]} mode selected for future turns.`);
    } catch (error) {
      set("set-continuity-mode", sessionOriginal.continuityMode || "reviewed");
      syncBalancedControls();
      feedback("Could not change mode: " + error.message, true);
    }
  });
  input("set-saver-review-every-turn").addEventListener("change", async () => {
    if (!state.sessionId || saving || state.busy) return;
    const checked = input("set-saver-review-every-turn").checked;
    try {
      if (!sessionOriginal.continuityEnabled) throw new Error("Select a continuity story.");
      await updateSession(state.sessionId, { continuitySaverReviewEveryTurn: checked });
      sessionOriginal.continuitySaverReviewEveryTurn = checked;
      feedback(checked ? "Every Saver or Balanced turn will wait for your review." : "Saver and Balanced will save valid turns automatically.");
    } catch (error) {
      input("set-saver-review-every-turn").checked = sessionOriginal.continuitySaverReviewEveryTurn === true;
      feedback("Could not change turn review setting: " + error.message, true);
    }
  });
  input("btn-load-continuity-editor").addEventListener("click", loadContinuityEditor);
  input("btn-save-continuity-editor").addEventListener("click", saveContinuityEditor);
  input("btn-accept-continuity-proposal").addEventListener("click", acceptContinuityProposal);
  input("btn-repair-continuity").addEventListener("click", repairContinuityEditor);
  document.addEventListener("open-continuity-editor", () => {
    openSettingsPopup();
    showPanel("story");
    void loadContinuityEditor();
  });
  input("btn-open-migration").addEventListener("click", () => {
    input("migration-panel").hidden = false;
    input("migration-output-editor").hidden = false;
    input("migration-note").focus();
  });
  input("migration-note").addEventListener("input", () => {
    preparedMigration = null;
    input("btn-publish-migration").hidden = true;
    input("migration-preview").hidden = true;
  });
  input("migration-output").addEventListener("input", () => {
    if (migrationRecovery?.sourceId === state.sessionId) migrationRecovery.output.content = raw("migration-output");
    preparedMigration = null;
    input("btn-publish-migration").hidden = true;
    input("migration-preview").hidden = true;
  });
  input("btn-validate-migration-output").addEventListener("click", handleValidateMigrationOutput);
  input("btn-load-migration-output").addEventListener("click", () => input("file-migration-output").click());
  input("file-migration-output").addEventListener("change", async (event) => {
    if (saving || state.busy) return;
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      const sourceId = state.sessionId;
      const text = await file.text();
      let saved;
      try { saved = JSON.parse(text); } catch { /* Raw invalid JSON remains editable. */ }
      if (saved?.legacyMessages && saved?.output) {
        if (saved.version !== 1 || saved.sourceId !== sourceId || typeof saved.note !== "string" ||
            !Array.isArray(saved.legacyMessages) || typeof saved.output?.content !== "string" ||
            typeof saved.output?.turnId !== "string" || typeof saved.title !== "string")
          throw new Error("Choose a recovery file for the currently selected original story.");
        const current = await getSession(sourceId);
        if (!current || current.continuityEnabled || sourceId !== state.sessionId || saving || state.busy)
          throw new Error("Select the original standard story and wait for the current request.");
        migrationRecovery = saved;
        restoreMigrationOutput();
      } else {
        if (!sourceId || sourceId !== state.sessionId || saving || state.busy)
          throw new Error("Select the original story and wait for the current request.");
        migrationRecovery = null;
        input("migration-panel").hidden = false;
        input("migration-output-editor").hidden = false;
        input("migration-thinking-panel").hidden = true;
        set("migration-output", text);
        if (typeof saved?.authorNote === "string") set("migration-note", saved.authorNote);
      }
      preparedMigration = null;
      input("btn-publish-migration").hidden = true;
      input("migration-preview").hidden = true;
      feedback("JSON loaded. Edit or validate it locally; no LLM request was made.");
    } catch (error) { feedback("Could not load migration output: " + error.message, true); }
    finally { event.target.value = ""; }
  });
  input("btn-save-migration-output").addEventListener("click", () => {
    let content = raw("migration-output");
    const hasRecovery = migrationRecovery?.sourceId === state.sessionId;
    if (hasRecovery) {
      migrationRecovery.output.content = content;
      content = JSON.stringify({ ...migrationRecovery, version: 1 }, null, 2);
    } else {
      try {
        const value = JSON.parse(content);
        if (value && typeof value === "object" && !Array.isArray(value))
          content = JSON.stringify({ ...value, authorNote: raw("migration-note").trim() || value.authorNote || "" }, null, 2);
      } catch { /* Preserve malformed text so it can still be repaired offline. */ }
    }
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = hasRecovery ? "migration-recovery.json" : "migration-final.json"; link.click();
    URL.revokeObjectURL(url);
  });
  input("btn-preview-migration").addEventListener("click", handlePreviewMigration);
  input("btn-publish-migration").addEventListener("click", handlePublishMigration);
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

export function openSettingsPopup(trigger = document.activeElement, options = {}) {
  if (!el.overlay.classList.contains("hidden")) return;
  opener = trigger;
  original = structuredClone(state.settings);
  draft = structuredClone(state.settings);
  petChoicesReady = false;
  el.overlay.classList.remove("hidden");
  el.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("settings-open");
  document.dispatchEvent(new CustomEvent("settings-visibility-changed"));
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
  document.dispatchEvent(new CustomEvent("settings-visibility-changed"));
  sessionId = null;
  set("set-session-title", ""); set("set-session-plan", ""); set("set-session-memory", "");
  resetMigrationPanel();
  resetContinuityEditor();
  for (const id of ["current-password", "new-password", "confirm-new-password"]) set(id, "");
  clearMessage();
  opener?.focus?.();
}

function globalDirty() { return JSON.stringify(draft) !== JSON.stringify(original); }
function sessionDirty() {
  if (sessionId !== state.sessionId) return false;
  return raw("set-session-title") !== sessionOriginal.title || raw("set-session-plan") !== sessionOriginal.longTermPlan ||
    raw("set-session-memory") !== sessionOriginal.shortMemory || Boolean(raw("migration-note").trim()) || editorDirty;
}
function accountDirty() {
  return ["current-password", "new-password", "confirm-new-password"].some((id) => raw(id) !== "");
}

function showPanel(name) {
  capture();
  petChoicesReady = false;
  const petRequest = ++petLoadRequest;
  panel = name;
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
  renderProfile();
  for (const [key, id] of Object.entries(contextFields)) set(id, draft[key]);
  input("set-auto-summarization").checked = draft.autoSummarizationEnabled === true;
  input("set-chat-recall").checked = draft.chatRecallEnabled === true;
  input("set-semantic-search").checked = draft.semanticSearchEnabled === true;
  input("set-short-memory").checked = draft.shortMemoryEnabled === true;
  set("set-pet-movement", draft.petMovement === "stay" ? "stay" : "roam");
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
  renderBalancedControls();
}
function renderBalancedControls() {
  const config = { ...DEFAULT_SETTINGS.balancedPreparation, ...draft.balancedPreparation };
  const selector = input("set-balanced-profile");
  const current = document.createElement("option");
  current.value = ""; current.textContent = "Current connection";
  selector.replaceChildren(current, ...draft.profiles.map((profile) => {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name; return option;
  }));
  if (config.profileId && !draft.profiles.some((profile) => profile.id === config.profileId)) {
    const missing = document.createElement("option"); missing.value = config.profileId; missing.textContent = "Deleted profile — choose another"; selector.append(missing);
  }
  selector.value = config.profileId;
  set("set-balanced-thinking", config.thinkingMode);
  set("set-balanced-effort", config.effort);
  set("set-balanced-maxtokens", config.maxTokens);
  syncBalancedControls();
}
function syncBalancedControls() {
  input("balanced-first-call-controls").hidden = raw("set-continuity-mode") !== "balanced";
  const mode = raw("set-balanced-thinking");
  input("balanced-effort-field").hidden = mode !== "effort";
  input("balanced-max-field").hidden = mode !== "max_tokens";
  input("set-balanced-effort").disabled = mode !== "effort";
  input("set-balanced-maxtokens").disabled = mode !== "max_tokens";
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
  draft.balancedPreparation = {
    profileId: raw("set-balanced-profile"), thinkingMode: raw("set-balanced-thinking"),
    effort: raw("set-balanced-effort"), maxTokens: raw("set-balanced-maxtokens").trim(),
  };
  draft.autoSummarizationEnabled = input("set-auto-summarization").checked;
  draft.chatRecallEnabled = input("set-chat-recall").checked;
  draft.semanticSearchEnabled = input("set-semantic-search").checked;
  draft.shortMemoryEnabled = input("set-short-memory").checked;
  draft.petMovement = raw("set-pet-movement") === "stay" ? "stay" : "roam";
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
    draft.petMovement = DEFAULT_SETTINGS.petMovement;
    set("set-pet-movement", draft.petMovement);
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
  const prep = result.balancedPreparation;
  const prepProfile = prep.profileId ? result.profiles.find((profile) => profile.id === prep.profileId) : activeProfile(result);
  if (!prepProfile) throw new Error("Choose an existing Balanced first-call profile.");
  if (prep.thinkingMode === "max_tokens") {
    prep.maxTokens = integerField(prep.maxTokens, "set-balanced-maxtokens");
    if (prep.maxTokens >= prepProfile.maxResponseTokens)
      throw new Error("Balanced thinking tokens must be below the selected profile's max response tokens.");
  }
  if (prepProfile.maxResponseTokens >= result.maxContextTokens)
    throw new Error("Max context tokens must exceed the Balanced first-call profile's max response tokens.");
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

function resetMigrationPanel() {
  preparedMigration = null;
  set("migration-note", "");
  set("migration-mode", "balanced");
  input("migration-panel").hidden = true;
  input("migration-preview").hidden = true;
  input("migration-preview").textContent = "";
  input("migration-token-progress").hidden = true;
  input("migration-token-progress").textContent = "";
  input("btn-publish-migration").hidden = true;
  input("migration-output-editor").hidden = true;
  input("migration-thinking-panel").hidden = true;
  set("migration-output", "");
  input("migration-thinking").textContent = "";
}

function restoreMigrationOutput() {
  if (migrationRecovery?.sourceId !== state.sessionId) return;
  set("migration-note", migrationRecovery.note);
  input("migration-panel").hidden = false;
  input("migration-output-editor").hidden = false;
  set("migration-output", migrationRecovery.output.content);
  input("migration-thinking").textContent = migrationRecovery.output.thinking || "";
  input("migration-thinking-panel").hidden = !migrationRecovery.output.thinking;
}

function resetContinuityEditor() {
  editorState = editorPending = null;
  editorDirty = false;
  editorRows = [];
  input("continuity-editor-body").hidden = true;
  input("continuity-state-rows").replaceChildren();
  set("continuity-new-record", "");
  input("continuity-editor-status").textContent = "";
}

async function loadContinuityEditor() {
  if (!state.sessionId) return;
  const id = state.sessionId;
  const body = input("continuity-editor-body");
  const status = input("continuity-editor-status");
  status.textContent = "Loading state…";
  try {
    const current = await getSession(id);
    if (!current?.continuityEnabled) throw new Error("Select a continuity story.");
    const { storyStore } = await import("../continuity/runtime.js");
    const store = storyStore(id);
    const branchId = current.continuityBranchId || "main";
    const loaded = await store.load(branchId);
    const pending = await store.readPending(branchId);
    if (state.sessionId !== id) return;
    editorState = { sessionId: id, branchId, revision: loaded.state.revision, records: loaded.state.records };
    editorPending = pending?.status === "needs_state_review" ? pending : null;
    editorDirty = false;
    editorRows = [];
    const rawOperations = Array.isArray(editorPending?.proposal?.operations) ? editorPending.proposal.operations : [];
    const { expandSaverOperation } = await import("../continuity/saver.js");
    const operations = rawOperations.map((operation) => {
      try { return expandSaverOperation(operation, loaded.state); }
      catch { return operation; } // Invalid updates remain pending for repair or author correction.
    });
    const suggested = new Map(operations
      .filter((operation) => typeof operation?.record?.id === "string" &&
        ["character", "relationship", "belief", "consequence", "scene", "agenda", "world_fact"].includes(operation.record.kind))
      .map((operation) => [operation.record.id, operation.record]));
    const saved = new Map(loaded.state.records.map((record) => [record.id, record]));
    const ids = [...new Set([...saved.keys(), ...suggested.keys()])];
    const tbody = input("continuity-state-rows");
    tbody.replaceChildren();
    for (const recordId of ids) {
      const old = saved.get(recordId);
      const proposal = suggested.get(recordId) ?? old;
      const row = document.createElement("tr");
      const label = document.createElement("th");
      label.textContent = `${old?.kind ?? proposal.kind} · ${recordId}`;
      const prior = document.createElement("td");
      const priorText = document.createElement("pre");
      priorText.textContent = old ? JSON.stringify(old.data, null, 2) : "New record";
      prior.appendChild(priorText);
      const next = document.createElement("td");
      const field = document.createElement("textarea");
      field.rows = 5;
      field.setAttribute("aria-label", `Proposed ${recordId} data`);
      field.value = JSON.stringify(proposal.data, null, 2);
      field.addEventListener("input", () => { editorDirty = true; });
      next.appendChild(field);
      const proof = document.createElement("td");
      const proofText = document.createElement("pre");
      const operation = operations.find((item) => item?.record?.id === recordId);
      proofText.textContent = JSON.stringify(operation
        ? { reason: operation.reason, events: operation.eventIds, evidence: operation.evidence }
        : { events: old?.eventIds ?? [], sources: old?.sources ?? [] }, null, 2);
      proof.appendChild(proofText);
      row.append(label, prior, next, proof);
      tbody.appendChild(row);
      editorRows.push({ id: recordId, kind: old?.kind ?? proposal.kind, field });
    }
    input("continuity-new-record").addEventListener("input", () => { editorDirty = true; }, { once: true });
    set("continuity-new-record", "");
    input("btn-repair-continuity").hidden = !editorPending;
    input("btn-accept-continuity-proposal").hidden = !editorPending;
    status.textContent = editorPending
      ? `Narration saved; state needs review: ${editorPending.error || "Invalid state update"}`
      : `Revision ${loaded.state.revision} · ${ids.length} records`;
    body.hidden = false;
  } catch (error) { status.textContent = "Could not load state: " + error.message; }
}

async function saveContinuityEditor() {
  if (!editorState || saving || state.busy || state.sessionId !== editorState.sessionId) return;
  saving = true;
  const button = input("btn-save-continuity-editor");
  button.disabled = true;
  try {
    const records = editorRows.map(({ id, kind, field }) => ({ id, kind, data: JSON.parse(field.value) }));
    const extra = raw("continuity-new-record").trim();
    if (extra) records.push(JSON.parse(extra));
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new Error("Duplicate record ID in the editor.");
    const { storyStore } = await import("../continuity/runtime.js");
    const { saveManualState } = await import("../continuity/saver.js");
    await saveManualState({ store: storyStore(editorState.sessionId), branchId: editorState.branchId,
      records, pendingTurnId: editorPending?.turnId ?? null, expectedRevision: editorState.revision });
    editorDirty = false;
    await loadContinuityEditor();
    feedback("Author correction saved.");
  } catch (error) { feedback("State correction failed: " + error.message, true); }
  finally { saving = false; button.disabled = false; }
}

async function repairContinuityEditor() {
  if (!editorState || !editorPending || saving || state.busy || state.sessionId !== editorState.sessionId) return;
  if (editorDirty) return feedback("Save your author corrections before requesting model repair.", true);
  if (!state.settings?.modelId || !state.settings?.apiKey)
    return feedback("Set a model and API key before requesting state repair.", true);
  saving = true;
  const button = input("btn-repair-continuity");
  button.disabled = true;
  try {
    const { storyStore } = await import("../continuity/runtime.js");
    const { repairSaverTurn } = await import("../continuity/saver.js");
    await repairSaverTurn({ store: storyStore(editorState.sessionId), branchId: editorState.branchId,
      turnId: editorPending.turnId, settings: structuredClone(state.settings) });
    editorDirty = false;
    await loadContinuityEditor();
    feedback("Saved narration and repaired state.");
  } catch (error) { feedback("State repair failed: " + error.message, true); }
  finally { saving = false; button.disabled = false; }
}

async function acceptContinuityProposal() {
  if (!editorState || !editorPending || saving || state.busy || state.sessionId !== editorState.sessionId) return;
  if (editorDirty) return feedback("Use Save author correction to apply your edited values.", true);
  saving = true;
  const button = input("btn-accept-continuity-proposal");
  button.disabled = true;
  try {
    const { storyStore } = await import("../continuity/runtime.js");
    const { acceptSaverPending } = await import("../continuity/saver.js");
    await acceptSaverPending({ store: storyStore(editorState.sessionId), branchId: editorState.branchId,
      turnId: editorPending.turnId });
    editorDirty = false;
    await loadContinuityEditor();
    feedback("Proposed story state accepted.");
  } catch (error) { feedback("Could not accept state: " + error.message, true); }
  finally { saving = false; button.disabled = false; }
}

function setContinuityStoryControls(enabled, nextOrder) {
  input("btn-enable-continuity").hidden = enabled || nextOrder > 0;
  input("btn-open-migration").hidden = enabled || nextOrder === 0;
  input("btn-view-continuity").hidden = !enabled;
  input("continuity-mode-controls").hidden = !enabled;
  input("continuity-editor").hidden = !enabled;
  input("continuity-state-preview").hidden = true;
  input("continuity-setting-status").textContent = enabled ? "Character continuity is active" :
    nextOrder > 0 ? "Create a reviewed continuity copy to keep this transcript." : "";
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
    resetMigrationPanel();
    resetContinuityEditor();
    return;
  }
  const requestedId = state.sessionId;
  if (sessionId !== requestedId) {
    sessionId = requestedId;
    sessionOriginal = { title: "", longTermPlan: "", shortMemory: "", nextOrder: 0 };
    set("set-session-title", ""); set("set-session-plan", ""); set("set-session-memory", "");
    setContinuityStoryControls(false, 0);
    input("btn-enable-continuity").hidden = true;
    resetMigrationPanel();
    resetContinuityEditor();
  } else if (sessionDirty()) return;
  try {
    const session = event?.detail?.sessionId === requestedId ? event.detail.session : await getSession(requestedId);
    if (requestedId !== state.sessionId || sessionDirty()) return;
    sessionId = requestedId;
    sessionOriginal = { title: session?.title ?? "", longTermPlan: session?.longTermPlan ?? "",
      shortMemory: session?.shortMemory ?? "", nextOrder: session?.nextOrder ?? 0,
      continuityEnabled: session?.continuityEnabled === true,
      continuityMode: session?.continuityMode || "reviewed",
      continuitySaverReviewEveryTurn: session?.continuitySaverReviewEveryTurn === true };
    set("set-session-title", sessionOriginal.title);
    set("set-session-plan", sessionOriginal.longTermPlan);
    set("set-session-memory", sessionOriginal.shortMemory);
    set("set-continuity-mode", sessionOriginal.continuityMode);
    syncBalancedControls();
    input("set-saver-review-every-turn").checked = sessionOriginal.continuitySaverReviewEveryTurn;
    setContinuityStoryControls(sessionOriginal.continuityEnabled, sessionOriginal.nextOrder);
    if (!sessionOriginal.continuityEnabled && input("migration-output-editor").hidden) restoreMigrationOutput();
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

async function handlePreviewMigration() {
  if (!state.sessionId || saving || state.busy) return;
  const sourceId = state.sessionId;
  const note = raw("migration-note").trim();
  if (!note) return feedback("Paste a reviewed author note first.", true);
  if (!state.settings?.modelId || !state.settings?.apiKey)
    return feedback("Set a model and API key before reviewing the migration.", true);
  saving = true;
  input("btn-preview-migration").disabled = true;
  input("btn-publish-migration").hidden = true;
  const progress = input("migration-token-progress");
  progress.hidden = false;
  progress.textContent = "Waiting for the model…";
  try {
    const source = await getSession(sourceId);
    if (!source || source.continuityEnabled) throw new Error("Select a standard story to migrate.");
    const [{ getMessagesReadOnly }, { prepareContinuityMigration }] = await Promise.all([
      import("../messages.js"), import("../continuity/migration.js"),
    ]);
    const legacyMessages = await getMessagesReadOnly(sourceId);
    const prepared = await prepareContinuityMigration({ legacyMessages, authorNote: note,
      settings: structuredClone(state.settings),
      onReviewOutput: (output) => {
        migrationRecovery = { sourceId, note, title: `${source.title || "Story"} (continuity)`, legacyMessages, output };
        if (state.sessionId === sourceId) {
          // Do not replace a changed author note while a response was in flight.
          input("migration-output-editor").hidden = false;
          set("migration-output", output.content);
          input("migration-thinking").textContent = output.thinking || "";
          input("migration-thinking-panel").hidden = !output.thinking;
        }
      },
      onStatus: (phase) => feedback(phase === "reviewing" ? "Model is generating migration output…"
        : phase === "validating_output" ? "Model response finished. Validating output…"
        : `Reviewing migration: ${phase.replaceAll("_", " ")}…`),
      onProgress: (stats) => {
        const parts = [`Received ~${Math.ceil(stats.receivedCharacters / 4).toLocaleString()} text tokens (estimate)`];
        const total = stats.usage?.completion_tokens;
        const thinking = stats.usage?.completion_tokens_details?.reasoning_tokens;
        if (Number.isFinite(total)) parts.push(`${total.toLocaleString()} output tokens reported`);
        if (Number.isFinite(thinking)) parts.push(`${thinking.toLocaleString()} reasoning tokens reported`);
        else if (stats.reasoningCharacters) parts.push(`~${Math.ceil(stats.reasoningCharacters / 4).toLocaleString()} reasoning tokens received (estimate)`);
        if (stats.finishReason) parts.push(`finish: ${stats.finishReason}`);
        if (stats.maxOutputTokens) parts.push(`limit: ${stats.maxOutputTokens.toLocaleString()}`);
        progress.textContent = parts.join(" · ");
      } });
    if (state.sessionId !== sourceId || raw("migration-note").trim() !== note)
      throw new Error("Story or migration note changed during review. Preview it again.");
    preparedMigration = { sourceId, note, title: `${source.title || "Story"} (continuity)`, prepared };
    const preview = input("migration-preview");
    preview.textContent = JSON.stringify({
      sourceMessages: prepared.sourceMessageCount,
      skippedSummaries: prepared.skippedSummaryCount,
      throughOrder: prepared.state.throughOrder,
      records: prepared.state.records,
      events: prepared.state.events,
    }, null, 2);
    preview.hidden = false;
    input("btn-publish-migration").hidden = false;
    feedback("Review the saved state below, then create the copy.");
  } catch (error) {
    preparedMigration = null;
    feedback("Migration review failed: " + error.message, true);
  } finally {
    saving = false;
    input("btn-preview-migration").disabled = false;
  }
}


async function handleValidateMigrationOutput() {
  if (saving || state.busy) return;
  const sourceId = state.sessionId;
  if (!sourceId) return feedback("Select the original story.", true);
  const content = raw("migration-output");
  let note = raw("migration-note").trim();
  if (!note) {
    try {
      const embedded = JSON.parse(content).authorNote;
      if (typeof embedded === "string") { note = embedded.trim(); set("migration-note", note); }
    } catch { /* Validation below reports malformed JSON once a note is supplied. */ }
  }
  if (!note) return feedback("Provide a reviewed author note for the JSON evidence, or include authorNote in the JSON.", true);
  let recovery = migrationRecovery?.sourceId === sourceId ? migrationRecovery : null;
  if (recovery && !recovery.manual && note !== recovery.note)
    return feedback("Restore the author note used for this response, or upload a standalone final JSON for your revised note.", true);
  if (recovery) { recovery.output.content = content; if (recovery.manual) recovery.note = note; }
  saving = true;
  input("btn-validate-migration-output").disabled = true;
  preparedMigration = null;
  input("btn-publish-migration").hidden = true;
  input("migration-preview").hidden = true;
  try {
    const current = await getSession(sourceId);
    if (!current || current.continuityEnabled || sourceId !== state.sessionId) throw new Error("Select the original standard story.");
    const { prepareContinuityMigration, prepareManualContinuityMigration } = await import("../continuity/migration.js");
    if (!recovery) {
      const { getMessagesReadOnly } = await import("../messages.js");
      recovery = { sourceId, note, title: `${current.title || "Story"} (continuity)`, manual: true,
        legacyMessages: await getMessagesReadOnly(sourceId), output: { content, thinking: "",
          turnId: `migration_manual_${crypto.randomUUID().replaceAll("-", "")}` } };
      migrationRecovery = recovery;
    }
    const prepared = recovery.manual
      ? await prepareManualContinuityMigration({ legacyMessages: recovery.legacyMessages, authorNote: recovery.note,
          settings: structuredClone(state.settings), migrationTurnId: recovery.output.turnId, output: content,
          onReviewOutput: (output) => { recovery.output.turnId = output.turnId; } })
      : await prepareContinuityMigration({ legacyMessages: recovery.legacyMessages, authorNote: recovery.note,
          settings: structuredClone(state.settings), migrationTurnId: recovery.output.turnId, reviewOutputOverride: content,
          complete: async () => { throw new Error("Edited output validation must not call the model."); } });
    if (state.sessionId !== recovery.sourceId || raw("migration-note").trim() !== recovery.note || raw("migration-output") !== content)
      throw new Error("Migration draft changed while validating. Validate it again.");
    preparedMigration = { sourceId: recovery.sourceId, note: recovery.note, title: recovery.title, prepared };
    const preview = input("migration-preview");
    preview.textContent = JSON.stringify({ sourceMessages: prepared.sourceMessageCount, skippedSummaries: prepared.skippedSummaryCount,
      throughOrder: prepared.state.throughOrder, records: prepared.state.records, events: prepared.state.events }, null, 2);
    preview.hidden = false;
    input("btn-publish-migration").hidden = false;
    feedback("Edited output validated without an LLM call. Review the state below, then create the copy.");
  } catch (error) { feedback("Edited output failed validation: " + error.message, true); }
  finally { saving = false; input("btn-validate-migration-output").disabled = false; }
}

async function handlePublishMigration() {
  const proposal = preparedMigration;
  if (!proposal || proposal.sourceId !== state.sessionId ||
      proposal.note !== raw("migration-note").trim() || saving || state.busy)
    return feedback("Preview this migration again before creating a copy.", true);
  saving = true;
  input("btn-publish-migration").disabled = true;
  try {
    const { publishContinuityMigration } = await import("../continuity/migration-runtime.js");
    const id = await publishContinuityMigration({ title: proposal.title,
      sourceSessionId: proposal.sourceId, prepared: proposal.prepared,
      continuityMode: raw("migration-mode") });
    migrationRecovery = null;
    resetMigrationPanel();
    document.dispatchEvent(new CustomEvent("session-imported", { detail: id }));
    feedback("Continuity copy created and selected. Review its saved state before continuing.");
  } catch (error) { feedback("Could not create continuity copy: " + error.message, true); }
  finally { saving = false; input("btn-publish-migration").disabled = false; }
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
