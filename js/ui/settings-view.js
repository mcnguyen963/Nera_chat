import { openDirectorState } from './director-view.js';
import { currentUid } from '../auth.js';
import { beginSettingsSave } from './pending-settings.js';
import {setIcon} from './icons.js';
import {initProviderPicker} from './provider-picker.js';
import {providerOrder,resetProviderCooldown} from '../provider-routing.js';
import {initModelPicker} from './model-picker.js';
import {effectiveActiveSettings,saveStorySettings} from '../story-settings-store.js';
import {STORY_SETTING_KEYS,defaultStorySettings,changedStoryFields,explicitStorySettings,resolveStorySettings} from '../story-settings.js';
import {addRoleTestProfiles} from '../model-profiles.js';
import {loadRewriteDefaultPrompt} from '../rewrite.js';
import {vibrationSupport} from '../stream-vibration.js';
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
  maxOutputPrice: "set-max-output-price",
  frequencyPenalty: "set-frequency-penalty", presencePenalty: "set-presence-penalty",
};
const contextFields = {
  maxContextTokens: "set-max-context", autoSummaryThresholdPercent: "set-auto-threshold",
  keepRecentMessagesAfterSummary: "set-keep-n", summarizerMaxTokens: "set-summarizer-maxtokens",
  summarizerChunkTokens: "set-summarizer-chunk",
  summarizerThinkingTokens: "set-summarizer-thinking",
};
const samplingRanges = { temperature: [0, 2], topP: [0, 1], frequencyPenalty: [-2, 2], presencePenalty: [-2, 2] };
let draft;
let modelPicker,providerPicker;
const providerResets=new Map();
let original;
let promptStoryId=null,promptBase=null;
let panel = "model";
let opener = null;
let sessionOriginal = { title: "", longTermPlan: "", allowLlmPlanUpdates: false };
let sessionId = null;
let saving = false;
let retainedDraft=false,viewVersion=0,draftOwner=null;
let petChoicesReady = false;
let petCatalog = [];
let petLoadRequest = 0;
let rewritePromptRequest=0,rewriteDefaultPrompt=null;

const input = (id) => document.getElementById(id);
const raw = (id) => input(id).value;
const set = (id, value) => { input(id).value = String(value ?? ""); };

export function initSettingsView() {
  modelPicker = initModelPicker({
    button: input('btn-fetch-models'), picker: input('model-picker'), search: input('model-search'),
    list: input('model-list'), status: input('model-status'), model: input('set-model'),
    endpoint: input('set-endpoint'), apiKey: input('set-apikey'), onSelect: () => {providerPicker?.connectionChanged();capture();},
  });
  if(input('btn-fetch-providers'))providerPicker=initProviderPicker({
    button:input('btn-fetch-providers'),search:input('provider-search'),list:input('provider-list'),selected:input('provider-selected'),status:input('provider-status'),
    endpoint:input('set-endpoint'),apiKey:input('set-apikey'),model:input('set-model'),
    connection:()=>{const settings=draft ?? state.settings ?? {};return {...settings,providerOrder:activeProfile(settings)?.providerOrder ?? settings.providerOrder ?? []};},
    onChange:order=>{if(!draft)return;capture();const profile=activeProfile(draft);if(profile){profile.providerOrder=order;draft.providerOrder=[...order];}},
    onReselect:(settings,tag)=>{providerResets.set(JSON.stringify([settings.activeProfileId,settings.endpoint,settings.modelId,tag]),{settings:structuredClone(settings),tag});},
  });
  input('stream-vibration-help').hidden=vibrationSupport()==='unsupported' ? false : true;
  input('btn-reset-rewrite-prompt').addEventListener('click',()=>{draft.rewriteSystemPrompt=defaultStorySettings().rewriteSystemPrompt;renderRewritePrompt();clearMessage();});
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
  document.querySelectorAll('[data-reset-prompt]').forEach(button=>button.addEventListener('click',()=>{draft[button.dataset.resetPrompt]=defaultStorySettings()[button.dataset.resetPrompt] ?? DEFAULT_SETTINGS[button.dataset.resetPrompt];set(button.dataset.promptField,draft[button.dataset.resetPrompt]);if(button.dataset.resetPrompt==='directorNarratorSystemPrompt'){draft.directorNarratorPromptNeedsReview=false;renderNarratorReview();}clearMessage();}));
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
  input('btn-role-test-profiles').addEventListener('click',()=>{
    capture();draft.profiles=addRoleTestProfiles(draft).profiles;renderProfile();
    feedback('Test profiles added. Save, then select them in Prompts.');
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
  input('btn-director-state').addEventListener('click',openDirectorState);
  input('btn-review-director-narrator').addEventListener('click',()=>{capture();draft.directorNarratorPromptNeedsReview=false;renderNarratorReview();feedback('Instructions reviewed. Save story prompts to apply.');});
  el.save.addEventListener("click", handleSaveSettings);
  el.reset.addEventListener("click", resetPanel);
  el.saveSession.addEventListener("click", handleSaveSession);
  input("btn-import-st").addEventListener("click", () => input("file-import-st").click());
  input("file-import-st").addEventListener("change", handleImport);
  input("btn-export-st").addEventListener("click", handleExport);
  input('btn-export-full').addEventListener('click',async()=>{if(state.busy){feedback('Finish the current turn first',true);return;}const b=input('btn-export-full');if(b.disabled || !state.sessionId)return;b.disabled=true;try{await storyTransfer.exportFullBackup(state.sessionId);feedback('Exported cached lore.');}catch(error){feedback('Export failed: '+error.message,true);}finally{b.disabled=false;}});
  document.addEventListener("session-changed", (event) => {
    if (!el.overlay.classList.contains("hidden") && (panel === "story" || panel === "memory") && (sessionId !== state.sessionId || !sessionDirty())) fillSession(event);
  });
  document.addEventListener('story-settings-changed',()=>{if(!saving && !el.overlay.classList.contains('hidden'))receiveSettingsChange();});
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
  if(retainedDraft && draftOwner===currentUid() && promptStoryId===state.sessionId){retainedDraft=false;if(options.panel)showPanel(options.panel);}
  else {retainedDraft=false;reloadGlobalSettings();showPanel(["pets", "memory", "story", "context", "transfer"].includes(options.panel) ? options.panel : "model");}
  input("btn-close-settings").focus();
}

function reloadGlobalSettings() {
  providerResets.clear();
  viewVersion++;draftOwner=currentUid();
  draft = structuredClone(state.settings);
  promptStoryId=state.sessionId;promptBase=null;
  try {const effective=resolveStorySettings(state.settings,state.storySettings);for(const key of STORY_SETTING_KEYS)draft[key]=effective[key];promptBase=structuredClone(state.storySettings.values);}catch{}
  renderAll(); providerPicker?.clear(); capture();
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
  capture();
  if (!saving && (globalDirty() || sessionDirty() || accountDirty()) && !confirm("Discard unsaved settings changes?")) return false;
  modelPicker?.reset();
  providerPicker?.reset();
  el.overlay.classList.add("hidden");
  el.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("settings-open");
  if(saving){retainedDraft=true;opener?.focus?.({preventScroll:true});return true;}
  sessionId = null;
  set("set-session-title", ""); set("set-session-plan", "");
  for (const id of ["current-password", "new-password", "confirm-new-password"]) set(id, "");
  clearMessage();
  opener?.focus?.({preventScroll:true});
  return true;
}

const numericDraftFields=new Set([...Object.keys(contextFields),'rewriteRecentMessages','modelContextTokens','maxResponseTokens','maxOutputPrice',...Object.keys(samplingRanges),'maxTokens','directorMaxInputTokens','directorMaxOutputTokens','directorRecentTurns','directorFocusLimit']);
function settingsSignature(value,key='') {
  // Inputs hold text; saved settings hold numbers. Compare their values rather
  // than reporting a successful save as another unsaved edit.
  if(numericDraftFields.has(key))return value==null?'':String(value);
  if(Array.isArray(value))return value.map(item=>settingsSignature(item));
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,settingsSignature(value[k],k)]));
  return value;
}
function globalDirty() { return providerResets.size>0 || JSON.stringify(settingsSignature(draft)) !== JSON.stringify(settingsSignature(original)); }
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
  setIcon(el.save, 'save', name==='prompts' ? 'Save story prompts' : 'Save shared settings');
  const promptHeading=document.querySelector('[data-panel="prompts"] h2');if(promptHeading)promptHeading.textContent='Prompts · '+(sessionOriginal.title || 'current story');
  if(name==='prompts' && state.sessionId)void getSession(state.sessionId).then(s=>{if(panel==='prompts' && promptHeading)promptHeading.textContent='Prompts · '+(s?.title ?? 'Select a story');}).catch(error=>feedback(error.message,true));
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
  const directorDefaults=defaultStorySettings();
  set('set-narration-mode',draft.narrationMode ?? 'classic');set('set-director-input',draft.directorMaxInputTokens ?? 20000);set('set-director-output',draft.directorMaxOutputTokens ?? 4000);set('set-director-turns',draft.directorRecentTurns ?? 5);set('set-director-focus',draft.directorFocusLimit ?? 5);set('set-director-prompt',draft.directorSystemPrompt ?? directorDefaults.directorSystemPrompt);
  const directorProfiles=input('set-director-profile');directorProfiles.replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent='Choose a profile';directorProfiles.append(empty);
  for(const profile of draft.profiles ?? []){const option=document.createElement('option');option.value=profile.id;option.textContent=profile.name || profile.modelId || profile.id;directorProfiles.append(option);}
  if(draft.directorProfileId && !(draft.profiles ?? []).some(p=>p.id===draft.directorProfileId)){const missing=document.createElement('option');missing.value=draft.directorProfileId;missing.textContent='Missing profile — choose another';directorProfiles.append(missing);}directorProfiles.value=draft.directorProfileId ?? '';
  const narratorProfiles=input('set-narrator-profile');narratorProfiles.replaceChildren();
  const current=document.createElement('option');current.value='';current.textContent='Use active profile';narratorProfiles.append(current);
  for(const profile of draft.profiles ?? []){const option=document.createElement('option');option.value=profile.id;option.textContent=profile.name || profile.modelId || profile.id;narratorProfiles.append(option);}
  if(draft.narratorProfileId && !(draft.profiles ?? []).some(p=>p.id===draft.narratorProfileId)){const missing=document.createElement('option');missing.value=draft.narratorProfileId;missing.textContent='Missing profile — choose another';narratorProfiles.append(missing);}narratorProfiles.value=draft.narratorProfileId ?? '';
  set("set-narrator-prompt", draft.narratorSystemPrompt);
  set("set-director-narrator-prompt",draft.directorNarratorSystemPrompt ?? directorDefaults.directorNarratorSystemPrompt);renderNarratorReview();
  set("set-summarizer-prompt", draft.summarizerSystemPrompt);
  set("set-memory-update-prompt", draft.memoryExtractionPrompt);
  set("set-memory-reorganize-prompt", draft.memoryReorganizePrompt);
  set('set-rewrite-n',draft.rewriteRecentMessages ?? 10);set('set-stream-vibration',draft.streamVibrationMode ?? 'spaces');renderRewritePrompt();
}
function renderNarratorReview() {
  const pending=draft.directorNarratorPromptNeedsReview===true;
  input('director-narrator-review').classList.toggle('hidden',!pending);
  input('btn-review-director-narrator').classList.toggle('hidden',!pending);
}
function renderRewritePrompt() {
  const request = ++rewritePromptRequest;
  const field = input("set-rewrite-prompt");
  const help = input("rewrite-prompt-help");
  if (draft.rewriteSystemPrompt != null) {
    field.disabled = false;
    field.value = draft.rewriteSystemPrompt;
    help.textContent = "Your saved prompt overrides system prompts/rewrite.md.";
    return;
  }
  field.disabled = true;
  field.value = rewriteDefaultPrompt ?? "";
  help.textContent = "Loading system prompts/rewrite.md…";
  void loadRewriteDefaultPrompt().then((prompt) => {
    if (request !== rewritePromptRequest) return;
    rewriteDefaultPrompt = prompt;
    field.value = prompt;
    field.disabled = false;
    help.textContent = "Using system prompts/rewrite.md. Edit here to save a custom prompt.";
  }).catch((error) => {
    if (request === rewritePromptRequest) help.textContent = error.message + " Click Use default rewrite prompt to retry.";
  });
}
function renderProfile() {
  modelPicker?.reset();
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
  providerPicker?.reset();
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
    if(profile.endpoint!==raw('set-endpoint').trim() || profile.modelId!==raw('set-model').trim())profile.providerOrder=[];
    profile.name = raw("set-profile-name").trim() || profile.name || "Default";
    for (const [key, id] of Object.entries(connectionFields)) profile[key] = raw(id).trim();
    profile.providerOrder=providerOrder(profile.providerOrder);
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
  draft.narrationMode=raw('set-narration-mode') || 'classic';draft.narratorProfileId=raw('set-narrator-profile');draft.directorProfileId=raw('set-director-profile');draft.directorSystemPrompt=raw('set-director-prompt') || defaultStorySettings().directorSystemPrompt;
  for(const [key,id,fallback] of [['directorMaxInputTokens','set-director-input',20000],['directorMaxOutputTokens','set-director-output',4000],['directorRecentTurns','set-director-turns',5],['directorFocusLimit','set-director-focus',5]])draft[key]=Number(raw(id) || fallback);
  draft.narratorSystemPrompt = raw("set-narrator-prompt");
  draft.directorNarratorSystemPrompt=raw("set-director-narrator-prompt");
  draft.directorNarratorPromptNeedsReview ??= false;
  draft.summarizerSystemPrompt = raw("set-summarizer-prompt");
  draft.memoryExtractionPrompt = raw("set-memory-update-prompt");
  draft.memoryReorganizePrompt = raw("set-memory-reorganize-prompt");
  draft.rewriteRecentMessages=raw('set-rewrite-n').trim();draft.streamVibrationMode=raw('set-stream-vibration');
  if(!input('set-rewrite-prompt').disabled){const prompt=raw('set-rewrite-prompt');draft.rewriteSystemPrompt=draft.rewriteSystemPrompt==null && prompt===rewriteDefaultPrompt ? null : prompt;}
}

function resetPanel() {
  capture();
  if (panel === "model") {
    const profile = activeProfile(draft);
    for (const key of ["streaming", "maxResponseTokens", "maxOutputPrice", "advancedParametersEnabled", "temperature", "topP", "frequencyPenalty", "presencePenalty"])
      profile[key] = DEFAULT_SETTINGS[key];
    profile.reasoning = structuredClone(DEFAULT_SETTINGS.reasoning);
    draft.streamVibrationMode=DEFAULT_SETTINGS.streamVibrationMode;set('set-stream-vibration',draft.streamVibrationMode);
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
    draft.rewriteRecentMessages=DEFAULT_SETTINGS.rewriteRecentMessages;draft.rewriteSystemPrompt=defaultStorySettings().rewriteSystemPrompt;set('set-rewrite-n',draft.rewriteRecentMessages);renderRewritePrompt();
    draft.directorNarratorSystemPrompt=defaultStorySettings().directorNarratorSystemPrompt;draft.directorNarratorPromptNeedsReview=false;set('set-director-narrator-prompt',draft.directorNarratorSystemPrompt);renderNarratorReview();
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
function validatedDraft(storyValues=null) {
  const result = {...structuredClone(draft),...(storyValues ?? {})};
  for (const profile of result.profiles) {
    for (const [key, id] of Object.entries(connectionFields)) {
      if (key in samplingRanges && profile.advancedParametersEnabled) {
        const [min, max] = samplingRanges[key];
        profile[key] = numberField(profile[key], id, min, max, true);
      } else if (key in samplingRanges && String(profile[key] ?? "").trim() === "") {
        profile[key] = null;
      }
    }
    profile.providerOrder=providerOrder(profile.providerOrder);
    profile.maxResponseTokens = integerField(profile.maxResponseTokens, "set-max-resp");
    profile.maxOutputPrice = numberField(profile.maxOutputPrice, "set-max-output-price", 0, Number.MAX_SAFE_INTEGER, true);
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
  if (result.summarizerThinkingTokens >= result.summarizerMaxTokens) throw new Error('Summary thinking tokens must be lower than the summary total output tokens.');
  result.rewriteRecentMessages=integerField(result.rewriteRecentMessages,'set-rewrite-n');
  if(!['off','speed','spaces'].includes(result.streamVibrationMode))throw new Error('Choose a valid vibration mode.');
  if(result.rewriteSystemPrompt!=null && !result.rewriteSystemPrompt.trim())throw new Error('Rewrite system prompt cannot be empty. Use the default or enter a prompt.');
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
  try { validated = panel==='prompts' ? explicitStorySettings({...draft,rewriteRecentMessages:integerField(draft.rewriteRecentMessages,'set-rewrite-n')}) : validatedDraft(Object.fromEntries(STORY_SETTING_KEYS.map(k=>[k,state.settings[k]]))); }
  catch (error) { feedback(error.message, true); return; }
  const version=viewVersion,owner=currentUid(),submitted=structuredClone(draft),savedPanel=panel;
  const resetSnapshot=[...providerResets.entries()];
  const finishSave=beginSettingsSave(owner,savedPanel==='prompts'?promptStoryId:null);let committed=false;
  saving = true; el.save.disabled = el.saveSession.disabled = true;feedback('Saving…');el.save.setAttribute('aria-busy','true');
  try {
    if(savedPanel==='prompts') {
      if(!promptBase || promptStoryId!==state.sessionId)throw new Error('Story changed or prompts have not loaded. Reopen Settings.');
      if(state.busy)throw new Error('Finish the current reply before saving story settings.');
      if(validated.narrationMode==='director' && !validated.directorProfileId)throw new Error('Choose a Director connection profile.');
      for(const key of ['narratorProfileId','directorProfileId'])if(validated[key] && !draft.profiles.some(p=>p.id===validated[key]))throw new Error('The selected '+(key==='narratorProfileId'?'Narrator':'Director')+' profile is missing. Choose another.');
      validated.directorNarratorPromptNeedsReview=false;
      const result=await saveStorySettings(promptStoryId,promptBase,changedStoryFields(promptBase,validated));
      committed=true;
      if(version!==viewVersion || owner!==currentUid())return;
      capture();promptBase=structuredClone(result.values);for(const key of STORY_SETTING_KEYS){if(JSON.stringify(draft[key])===JSON.stringify(submitted[key]))draft[key]=result.values[key];original[key]=result.values[key];}renderAll();feedback('Story prompts saved ✓');refreshContextIndicator();return;
    }
    for(const key of STORY_SETTING_KEYS){if(state.settings[key]===undefined)delete validated[key];else validated[key]=state.settings[key];}
    const promptDraft=Object.fromEntries(STORY_SETTING_KEYS.map(k=>[k,draft[k]])),promptOriginal=Object.fromEntries(STORY_SETTING_KEYS.map(k=>[k,original[k]]));
    await saveSettings(validated);
    for(const [key,reset] of resetSnapshot) {
      const profile=validated.profiles.find(p=>p.id===reset.settings.activeProfileId);
      if(profile?.endpoint===reset.settings.endpoint && profile?.modelId===reset.settings.modelId && profile.providerOrder?.includes(reset.tag))resetProviderCooldown({...reset.settings,providerCooldownAccount:owner},reset.tag);
      if(providerResets.get(key)===reset)providerResets.delete(key);
    }
    committed=true;
    if(version!==viewVersion || owner!==currentUid())return;
    capture();const newer=Object.fromEntries(Object.entries(draft).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(submitted[key])));
    original = {...structuredClone(state.settings),...promptOriginal};
    draft = {...structuredClone(state.settings),...promptDraft,...newer};
    renderAll();
    capture();
    feedback(globalDirty()?'Saved. New edits are unsaved.':'Saved ✓');
    refreshContextIndicator();
  } catch (error) {
    if(version!==viewVersion || owner!==currentUid())return;
    if (error.code==='settings-reloaded') {
      receiveSettingsChange();
      if (globalDirty()) return;
    }
    feedback("Save failed: " + error.message, true);
  }
  finally {finishSave(committed);saving = false; el.save.disabled = el.saveSession.disabled = false;el.save.setAttribute('aria-busy','false'); }
}
function feedback(message, error = false) {
  el.message.textContent = message;
  el.message.style.color = error ? "var(--danger)" : "var(--ok)";
}
function clearMessage() { if (el.message) {if(saving)feedback('Saving…');else el.message.textContent = "";} }

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
  const version=viewVersion,owner=currentUid(),requestedId=state.sessionId;
  const finishSave=beginSettingsSave(owner,requestedId);let committed=false;
  saving = true; el.saveSession.disabled = el.save.disabled = true;feedback('Saving…');el.saveSession.setAttribute('aria-busy','true');
  try {
    const titleInput=raw('set-session-title'),title = titleInput.trim() || "Untitled";
    const longTermPlan = raw("set-session-plan");
    const submittedMemory=readMemory();
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
    if(requestedId!==state.sessionId || owner!==currentUid() || version!==viewVersion)throw new Error('Story changed. Reopen settings.');
    if (requestedId !== sessionId) throw new Error('Story changed. Reopen settings.');
    if (Object.keys(partial).length) await updateSession(requestedId, partial);
    committed=true;
    if(version!==viewVersion || requestedId!==state.sessionId || owner!==currentUid())return;
    sessionOriginal = { ...sessionOriginal, title, longTermPlan, ...(nextMemory ? { memory: nextMemory } : {}), ...('memoryState.extractedThroughOrder' in partial ? { memoryState: { ...sessionOriginal.memoryState, extractedThroughOrder: partial['memoryState.extractedThroughOrder'] } } : {}) };
    document.dispatchEvent(new CustomEvent('memory-session-saved', { detail: { sessionId: requestedId, partial } }));
    if(raw('set-session-title')===titleInput)set("set-session-title", title);
    if(nextMemory && JSON.stringify(readMemory())===JSON.stringify(submittedMemory))fillMemory(normalizeMemory(sessionOriginal.memory));
    feedback("Session saved ✓");
    refreshContextIndicator();
  } catch (error) {if(version===viewVersion && owner===currentUid())feedback("Save failed: " + error.message, true); }
  finally {finishSave(committed);saving = false; el.saveSession.disabled = el.save.disabled = false;el.saveSession.setAttribute('aria-busy','false'); }
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
  try { await exportSillyTavern(state.sessionId);feedback('Exported cached lore.'); }
  catch (error) { feedback("Export failed: " + error.message, true); }
}
