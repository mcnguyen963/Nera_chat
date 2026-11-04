export function createQuickControls(ctx) {
async function saveQuickRoleProfile(key,value) {
  try{
    if(ctx.busy)throw new Error('Finish the current reply before changing profiles.');
    if(!ctx.state.sessionId || ctx.state.storySettingsId!==ctx.state.sessionId || !ctx.state.storySettings || ctx.state.storySettingsLoadFailed)throw new Error('Story settings have not loaded.');
    if(!value && key==='directorProfileId')throw new Error('Choose a Director profile.');
    if(value && !ctx.state.settings.profiles.some(p=>p.id===value))throw new Error('Choose an existing profile.');
    await ctx.saveStorySettings(ctx.state.sessionId,ctx.state.storySettings.values,{[key]:value});
  }catch(error){ctx.showTransientError(error.message);}
  refreshQuickControls();
}
function initQuickControls() {
  ctx.el.quickProfile = document.getElementById("quick-profile");
  ctx.el.quickDirector = document.getElementById('quick-director-profile');
  ctx.el.quickThinking = document.getElementById("quick-thinking");
  ctx.el.quickThinkingButton = document.getElementById('quick-thinking-button');
  ctx.thinkingPicker = ctx.initThinkingPicker({button:ctx.el.quickThinkingButton, menu:document.getElementById('quick-thinking-menu'), select:ctx.el.quickThinking});
  ctx.el.quickDirector.addEventListener('change',()=>saveQuickRoleProfile('directorProfileId',ctx.el.quickDirector.value));

  ctx.el.quickProfile.addEventListener("change", async () => {
    if(ctx.storyRoleProfiles())return saveQuickRoleProfile('narratorProfileId',ctx.el.quickProfile.value);
    const s = structuredClone(ctx.state.settings);
    if (!s) return;
    s.activeProfileId = ctx.el.quickProfile.value;
    ctx.normalizeProfiles(s);
    ctx.mirrorFromActiveProfile(s); // load the chosen profile's connection fields
    try {await ctx.saveSettings(s);}catch(error){ctx.showTransientError(error.message);refreshQuickControls();}
  });

  ctx.el.quickThinking.addEventListener("change", async () => {
    const s = structuredClone(ctx.state.settings);
    if (!s) return;
    const selected=ctx.state.storySettings?.values?.narratorProfileId;
    let connection;
    try{connection=ctx.resolveModelProfile(s,selected,{role:'Narrator'});}catch(error){ctx.showTransientError(error.message);refreshQuickControls();return;}
    const v = ctx.el.quickThinking.value;
    const label = `Thinking: ${Array.from(ctx.el.quickThinking.options || []).find(option=>option.value===v)?.textContent || v}`;
    ctx.thinkingPicker?.sync(v,label);
    const glyph = document.getElementById('quick-thinking-icon');
    if (glyph) glyph.innerHTML = ctx.thinkingIcon(v);
    if (v === "off") {
      connection.reasoning = { ...connection.reasoning, enabled: false };
    } else if (v === "max_tokens") {
      connection.reasoning = { ...connection.reasoning, enabled: true, mode: "max_tokens" };
    } else {
      connection.reasoning = { ...connection.reasoning, enabled: true, mode: "effort", effort: v };
    }
    ctx.normalizeProfiles(s);
    if(selected && selected!==s.activeProfileId)s.profiles.find(p=>p.id===selected).reasoning=connection.reasoning;
    else{s.reasoning=connection.reasoning;ctx.mirrorToActiveProfile(s);}
    try {await ctx.saveSettings(s);}catch(error){ctx.showTransientError(error.message);refreshQuickControls();}
  });

  document.addEventListener('story-settings-changed',async (/** @type {CustomEvent} */ e)=>{const sid=ctx.state.sessionId;if(e.detail?.sessionPatch){await ctx.chatLoading;if(sid!==ctx.state.sessionId)return;}if(ctx.session && ctx.state.storySettings){ctx.session={...ctx.session,...e.detail?.sessionPatch,storySettingsRevision:ctx.state.storySettings.revision};const local=ctx.storyStore(ctx.state.sessionId);if(local && !local.status.pending)local.adopt({session:ctx.session,messages:ctx.historyMessages ?? local.view.messages,turns:local.view.turns});}refreshQuickControls();ctx.refreshContextIndicator();});
  document.addEventListener("settings-changed", refreshQuickControls);
  document.addEventListener("settings-changed", ctx.updateIndicator);
  refreshQuickControls();
}

function fillQuickProfileSelect(s) {
  if (!s) return;
  ctx.el.quickProfile.replaceChildren(
    ...s.profiles.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${ctx.storyRoleProfiles()?'Narrator · ':''}${p.modelId || 'No model'} · ${p.name}`;
      return o;
    })
  );
  if(ctx.storyRoleProfiles()){
    const option=document.createElement('option');option.value='';option.textContent='Narrator · Active profile';ctx.el.quickProfile.replaceChildren(option,...Array.from(ctx.el.quickProfile.children));
    const id=ctx.state.storySettings.values.narratorProfileId ?? '';
    if(id&&!s.profiles.some(p=>p.id===id)){const missing=document.createElement('option');missing.value=id;missing.textContent='Missing Narrator profile';ctx.el.quickProfile.append(missing);}ctx.el.quickProfile.value=id;
  }else ctx.el.quickProfile.value = s.activeProfileId;
}

function quickThinkingValue(s) {
  const r = s?.reasoning;
  if (!r?.enabled) return "off";
  return r.mode === "max_tokens" ? "max_tokens" : r.effort ?? "medium";
}

function refreshQuickControls() {
  const s = ctx.state.settings;
  if (!s) return;
  ctx.normalizeProfiles(s);
  let connection=s;
  try{connection=ctx.resolveModelProfile(s,ctx.state.storySettings?.values?.narratorProfileId,{role:'Narrator'});}catch{}
  const p = ctx.activeProfile(connection);
  fillQuickProfileSelect(s);
  ctx.el.quickThinking.value = quickThinkingValue(connection);
  ctx.el.quickProfile.title = p?.name
    ? `Narrator: ${p.name} · ${connection.modelId || "no model"}`
    : connection.modelId || "Model not set";
  const thinkingMode = quickThinkingValue(connection);
  const thinkingLabel = `Thinking: ${Array.from(ctx.el.quickThinking.options || []).find(option=>option.value===thinkingMode)?.textContent || thinkingMode}`;
  ctx.el.quickThinking.title = thinkingLabel;
  ctx.el.quickThinking.setAttribute('aria-label', thinkingLabel);
  ctx.thinkingPicker?.sync(thinkingMode,thinkingLabel);
  const thinkingGlyph = document.getElementById('quick-thinking-icon');
  if (thinkingGlyph) {
    thinkingGlyph.innerHTML = ctx.thinkingIcon(thinkingMode);
    thinkingGlyph.parentElement?.setAttribute('title', thinkingLabel);
  }
  const director=ctx.state.storySettings?.values?.narrationMode==='director',id=ctx.state.storySettings?.values?.directorProfileId ?? '';
  document.getElementById('quick-director-control').classList.toggle('hidden',!director);
  ctx.el.quickDirector.replaceChildren();
  const choice=document.createElement('option');choice.value='';choice.textContent='Director · Choose profile';ctx.el.quickDirector.append(choice);
  for(const profile of s.profiles){const option=document.createElement('option');option.value=profile.id;option.textContent='Director · '+(profile.name || profile.modelId);ctx.el.quickDirector.append(option);}
  if(id&&!s.profiles.some(p=>p.id===id)){const missing=document.createElement('option');missing.value=id;missing.textContent='Missing Director profile';ctx.el.quickDirector.append(missing);}ctx.el.quickDirector.value=id;
}


return {initQuickControls,refreshQuickControls};
}
