import {requestInputLimit} from '../request-budget.js';
import { diffMemorySettings } from '../session-memory.js';
import { fillMemory, readMemory, memoryDirty, initMemorySettings, chooseMemoryStart } from './memory-settings-view.js';
import { normalizeMemory } from '../memory-settings.js';
import { state } from "../state.js";
import { DEFAULT_SETTINGS, saveSettings, activeProfile, mirrorToActiveProfile, mirrorFromActiveProfile } from "../settings.js";
import { getSession, updateSession } from "../sessions.js";
import * as storyTransfer from "../import-export.js";
const {importSillyTavern,exportSillyTavern}=storyTransfer;
import { refreshContextIndicator } from "./chat-view.js";

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
  summarizerChunkTokens: "set-summarizer-chunk",
};
const samplingRanges = { temperature: [0, 2], topP: [0, 1], frequencyPenalty: [-2, 2], presencePenalty: [-2, 2] };
let draft;
let original;
let panel = "model";
let opener = null;
let sessionOriginal = { title: "", longTermPlan: "", allowLlmPlanUpdates: false };
let sessionId = null;
let saving = false;
let petChoicesReady = false;
let petCatalog = [];
let petLoadRequest = 0;

const input = (id) => document.getElementById(id);
const raw = (id) => input(id).value;
const set = (id, value) => { input(id).value = String(value ?? ""); };

export function initSettingsView() {
  const openLore = (options = {}) => { if (closeSettingsPopup() !== false) document.dispatchEvent(new CustomEvent('lorebooks', { detail: options })); };
  initMemorySettings(() => openLore());
  input('btn-lore-transfer').addEventListener('click', () => openLore({ screen: 'transfer' }));
  document.addEventListener('memory-settings', e => { openSettingsPopup(document.activeElement, { panel: 'memory' }); if (e.detail?.focus) setTimeout(() => input(e.detail.focus)?.focus(), 100); });
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
  document.querySelectorAll('[data-reset-prompt]').forEach(button=>button.addEventListener('click',()=>{draft[button.dataset.resetPrompt]=DEFAULT_SETTINGS[button.dataset.resetPrompt];set(button.dataset.promptField,draft[button.dataset.resetPrompt]);clearMessage();}));
  for(const id of ['set-reasoning-maxtokens','set-max-resp'])input(id).addEventListener('input',syncOptionalControls);
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
  el.save.addEventListener("click", handleSaveSettings);
  el.reset.addEventListener("click", resetPanel);
  el.saveSession.addEventListener("click", handleSaveSession);
  input("btn-import-st").addEventListener("click", () => input("file-import-st").click());
  input("file-import-st").addEventListener("change", handleImport);
  input("btn-export-st").addEventListener("click", handleExport);
  document.addEventListener("session-changed", (event) => {
    if (!el.overlay.classList.contains("hidden") && (panel === "story" || panel === "memory") && (sessionId !== state.sessionId || !sessionDirty())) fillSession(event);
  });
  document.addEventListener("settings-changed", () => {
    if (el.overlay.classList.contains("hidden")) return;
    if (saving) return;
    receiveSettingsChange();
  });
}

export function openSettingsPopup(trigger = document.activeElement, options = {}) {
  if (!el.overlay.classList.contains("hidden")) { if (options.panel) showPanel(options.panel); return; }
  opener = trigger;
  petChoicesReady = false;
  el.overlay.classList.remove("hidden");
  el.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("settings-open");
  reloadGlobalSettings();
  showPanel(["pets", "memory", "story", "context", "transfer"].includes(options.panel) ? options.panel : "model");
  input("btn-close-settings").focus();
}

function reloadGlobalSettings() {
  draft = structuredClone(state.settings);
  renderAll(); capture();
  original = structuredClone(draft);
  clearMessage();
}
function receiveSettingsChange() {
  // Textareas are captured on navigation/save, so inspect the live fields first.
  capture();
  if (!globalDirty()) { reloadGlobalSettings(); return; }
  feedback('Settings changed on another device — ');
  const choice = (id,label,action) => {
    const button=document.createElement('button');button.id=id;button.type='button';button.className='btn small';button.textContent=label;button.addEventListener('click',action);return button;
  };
  el.message.append(choice('settings-reload-remote','Reload',reloadGlobalSettings),choice('settings-keep-mine','Keep mine',()=>feedback('Your unsaved settings were kept.')));
}

function closeSettingsPopup() {
  if (saving) return false;
  capture();
  if ((globalDirty() || sessionDirty() || accountDirty()) && !confirm("Discard unsaved settings changes?")) return false;
  el.overlay.classList.add("hidden");
  el.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("settings-open");
  sessionId = null;
  set("set-session-title", ""); set("set-session-plan", "");
  for (const id of ["current-password", "new-password", "confirm-new-password"]) set(id, "");
  clearMessage();
  opener?.focus?.();
  return true;
}

function globalDirty() { return JSON.stringify(draft) !== JSON.stringify(original); }
function sessionDirty() {
  if (sessionId !== state.sessionId) return false;
  return raw("set-session-title") !== sessionOriginal.title ||
    raw("set-session-plan") !== sessionOriginal.longTermPlan ||
    memoryDirty(sessionOriginal.memory);
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
  el.footer.classList.toggle("hidden", !global && !["story", "memory"].includes(name));
  el.save.classList.toggle("hidden", !global);
  el.reset.classList.toggle("hidden", !global);
  el.saveSession.classList.toggle("hidden", !["story", "memory"].includes(name));
  clearMessage();
  if (["story", "memory"].includes(name)) fillSession();
}

function renderAll() {
  set("set-pet-movement", draft.petMovement === "stay" ? "stay" : "roam");
  if (petChoicesReady && panel === "pets") renderPetChoices(draft.petCharacterIds);
  renderProfile();
  for (const [key, id] of Object.entries(contextFields)) set(id, draft[key]);
  input("set-auto-summary-enabled").checked = draft.autoSummarizationEnabled === true;
  set('set-model-context',draft.modelContextTokens ?? '');
  set("set-narrator-prompt", draft.narratorSystemPrompt);
  set("set-summarizer-prompt", draft.summarizerSystemPrompt);
  set("set-memory-update-prompt", draft.memoryExtractionPrompt);
  set("set-memory-reorganize-prompt", draft.memoryReorganizePrompt);
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
  const cap=Math.max(0,Math.min(Number(raw('set-reasoning-maxtokens'))||0,(Number(raw('set-max-resp'))||0)-1));input('set-reasoning-cap').textContent=Number(raw('set-reasoning-maxtokens'))>=Number(raw('set-max-resp')) ? `Reasoning budget capped at ${cap} (must be below max response tokens).` : '';
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
  draft.modelContextTokens=raw('set-model-context').trim();
  draft.narratorSystemPrompt = raw("set-narrator-prompt");
  draft.summarizerSystemPrompt = raw("set-summarizer-prompt");
  draft.memoryExtractionPrompt = raw("set-memory-update-prompt");
  draft.memoryReorganizePrompt = raw("set-memory-reorganize-prompt");
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
    draft.modelContextTokens=null;set('set-model-context','');
    for (const [key, id] of Object.entries(contextFields)) { draft[key] = DEFAULT_SETTINGS[key]; set(id, draft[key]); }
    draft.autoSummarizationEnabled = DEFAULT_SETTINGS.autoSummarizationEnabled;
    input("set-auto-summary-enabled").checked = draft.autoSummarizationEnabled;
  } else if (panel === "pets") {
    draft.petCharacterIds = structuredClone(DEFAULT_SETTINGS.petCharacterIds);
    draft.petMovement = DEFAULT_SETTINGS.petMovement;
    set("set-pet-movement", draft.petMovement);
    renderPetChoices(draft.petCharacterIds);
  } else if (panel === "prompts") {
    draft.narratorSystemPrompt = DEFAULT_SETTINGS.narratorSystemPrompt;
    draft.summarizerSystemPrompt = DEFAULT_SETTINGS.summarizerSystemPrompt;
    draft.memoryExtractionPrompt = DEFAULT_SETTINGS.memoryExtractionPrompt;
    draft.memoryReorganizePrompt = DEFAULT_SETTINGS.memoryReorganizePrompt;
    set("set-narrator-prompt", draft.narratorSystemPrompt);
    set("set-summarizer-prompt", draft.summarizerSystemPrompt);
    set("set-memory-update-prompt", draft.memoryExtractionPrompt);
    set("set-memory-reorganize-prompt", draft.memoryReorganizePrompt);
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
export function normalizeReasoningBudget(value,responseLimit) {
  const text=String(value ?? '').trim(),parsed=text ? Number(text) : NaN;
  const budget=Number.isFinite(parsed) ? Math.trunc(parsed) : DEFAULT_SETTINGS.reasoning.maxTokens;
  return Math.max(1,Math.min(budget,Math.max(1,responseLimit-1)));
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
    profile.reasoning={...DEFAULT_SETTINGS.reasoning,...profile.reasoning};
    profile.reasoning.maxTokens=normalizeReasoningBudget(profile.reasoning.maxTokens,profile.maxResponseTokens);
    if (profile.reasoning.enabled && profile.reasoning.mode === "max_tokens") {
      if (profile.reasoning.maxTokens >= profile.maxResponseTokens) {
        throw new Error("Reasoning max tokens must be lower than Max response tokens (reasoning counts toward the response limit).");
      }
    }
    if (profile.endpoint && !/^https?:\/\//i.test(profile.endpoint)) throw new Error("Endpoint URL must start with http:// or https://.");
  }
  for (const [key, id] of Object.entries(contextFields)) result[key] = integerField(result[key], id);
  result.modelContextTokens=String(result.modelContextTokens ?? '').trim() ? integerField(result.modelContextTokens,'set-model-context') : null;
  mirrorFromActiveProfile(result);
  for (const profile of result.profiles) {
    try { requestInputLimit({...result,maxResponseTokens:profile.maxResponseTokens}); }
    catch(error) {throw new Error('Profile "'+profile.name+'": '+error.message);}
  }

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
    if (error.code==='settings-reloaded') {
      receiveSettingsChange();
      if (globalDirty()) return;
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
    sessionOriginal = { title: "", longTermPlan: "", allowLlmPlanUpdates: false };
    set("set-session-title", ""); set("set-session-plan", "");
    fillMemory();
    return;
  }
  const requestedId = state.sessionId;
  if (sessionId !== requestedId) {
    sessionId = requestedId;
    sessionOriginal = { title: "", longTermPlan: "", allowLlmPlanUpdates: false };
    set("set-session-title", ""); set("set-session-plan", "");
    fillMemory();
  } else if (sessionDirty()) return;
  try {
    const session = event?.detail?.sessionId === requestedId ? event.detail.session : await getSession(requestedId);
    if (requestedId !== state.sessionId || sessionDirty()) return;
    sessionId = requestedId;
    sessionOriginal = {
      title: session?.title ?? "", longTermPlan: session?.longTermPlan ?? "",
      allowLlmPlanUpdates:false, memory: normalizeMemory(session?.memory), memoryState: session?.memoryState,
    };
    set("set-session-title", sessionOriginal.title);
    set("set-session-plan", sessionOriginal.longTermPlan);
    fillMemory(sessionOriginal.memory);
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
    const partial = {};
    if (title !== sessionOriginal.title) partial.title=title;
    if (longTermPlan !== sessionOriginal.longTermPlan) partial.longTermPlan=longTermPlan;
    let nextMemory=null;
    if (panel === 'memory' || memoryDirty(sessionOriginal.memory)) {
      nextMemory = readMemory(true, integerField);
      const budget = nextMemory.lorebooks ? Object.values(nextMemory.books).filter(b => b.on).reduce((n,b) => n+b.budget,0) : 0;
      if (budget > .9*(requestInputLimit(state.settings))) throw new Error('Book budgets are larger than the space available. Lower them or raise Max context tokens (Context & summaries).');
      const start = await chooseMemoryStart(nextMemory, normalizeMemory(sessionOriginal.memory), sessionOriginal);
      if (start === 'cancel') return;
      Object.assign(partial,diffMemorySettings(normalizeMemory(sessionOriginal.memory),nextMemory));
      if (start != null && start !== sessionOriginal.memoryState?.extractedThroughOrder) partial['memoryState.extractedThroughOrder'] = start;
    }
    const requestedId = state.sessionId;
    if (requestedId !== sessionId) throw new Error('Story changed. Reopen settings.');
    if (Object.keys(partial).length) await updateSession(requestedId, partial);
    sessionOriginal = { ...sessionOriginal, title, longTermPlan, ...(nextMemory ? { memory: nextMemory } : {}), ...('memoryState.extractedThroughOrder' in partial ? { memoryState: { ...sessionOriginal.memoryState, extractedThroughOrder: partial['memoryState.extractedThroughOrder'] } } : {}) };
    document.dispatchEvent(new CustomEvent('memory-session-saved', { detail: { sessionId: requestedId, partial } }));
    set("set-session-title", title);
    if(nextMemory)fillMemory(normalizeMemory(sessionOriginal.memory));
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
    feedback(storyTransfer.importReport?.(id)?.message ?? 'Imported. Background memory is off — turn it on in Memory settings.');
    input("set-session-title").focus();
  } catch (error) { feedback("Import failed: " + error.message, true); }
}
async function handleExport() {
  if (!state.sessionId) return feedback("Select a story first.", true);
  try { await exportSillyTavern(state.sessionId); }
  catch (error) { feedback("Export failed: " + error.message, true); }
}
