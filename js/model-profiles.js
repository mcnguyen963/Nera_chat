// Resolve task-local connections without changing the shared active profile.
export function resolveModelProfile(settings,profileId,{role='Selected'}={}) {
  if(!profileId || profileId===settings.activeProfileId)return structuredClone(settings);
  const profile=settings.profiles?.find(p=>p.id===profileId);
  if(!profile)throw new Error('The '+role+' model profile no longer exists. Choose another saved profile.');
  const advanced=profile.advancedParametersEnabled ?? ['temperature','topP','frequencyPenalty','presencePenalty'].some(k=>profile[k]!=null&&profile[k]!=='');
  return {...structuredClone(settings),activeProfileId:profile.id,endpoint:profile.endpoint ?? '',apiKey:profile.apiKey ?? '',modelId:profile.modelId ?? '',streaming:profile.streaming ?? true,
    maxResponseTokens:profile.maxResponseTokens ?? settings.maxResponseTokens,maxOutputPrice:profile.maxOutputPrice ?? null,modelContextTokens:profile.modelContextTokens ?? null,
    reasoning:structuredClone(profile.reasoning ?? {}),advancedParametersEnabled:advanced,
    ...Object.fromEntries(['temperature','topP','frequencyPenalty','presencePenalty'].map(k=>[k,profile[k] ?? null]))};
}
export const ROLE_TEST_PROFILES=Object.freeze([
  Object.freeze({role:'director',name:'Haiku 5.5 · medium',modelId:'anthropic/claude-haiku-5.5:floor',maxOutputPrice:.5}),
  Object.freeze({role:'narrator',name:'DeepSeek Flash · high',modelId:'deepseek/deepseek-v4.1-flash:floor',maxOutputPrice:.4})
]);
export function addRoleTestProfiles(settings,newId=()=>crypto.randomUUID()) {
  const profiles=structuredClone(settings.profiles ?? []),ids={},source=profiles.find(p=>p.id===settings.activeProfileId) ?? settings;
  for(const preset of ROLE_TEST_PROFILES){
    const effort=preset.role==='director'?'medium':'high';
    let profile=profiles.find(p=>p.modelId===preset.modelId && /^https:\/\/openrouter\.ai\//i.test(p.endpoint ?? '') && p.reasoning?.enabled===true && p.reasoning?.mode==='effort' && p.reasoning?.effort===effort && p.maxOutputPrice===preset.maxOutputPrice && p.maxResponseTokens===8192 && p.advancedParametersEnabled!==true && (preset.role==='director'||p.streaming!==false));
    if(!profile){profile={id:newId(),name:preset.name,endpoint:'https://openrouter.ai/api/v1/chat/completions',apiKey:/^https:\/\/openrouter\.ai\//i.test(source.endpoint ?? '') ? source.apiKey ?? '' : '',modelId:preset.modelId,streaming:preset.role==='narrator',maxResponseTokens:8192,maxOutputPrice:preset.maxOutputPrice,advancedParametersEnabled:false,temperature:null,topP:null,frequencyPenalty:null,presencePenalty:null,reasoning:{enabled:true,mode:'effort',effort:preset.role==='director'?'medium':'high',maxTokens:4096}};profiles.push(profile);}
    ids[preset.role]=profile.id;
  }
  return {profiles,ids};
}
