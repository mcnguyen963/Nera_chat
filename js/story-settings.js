import { prompts } from './system-prompts.js';
export const STORY_SETTINGS_VERSION=5;
export const STORY_SETTING_KEYS=Object.freeze(['narratorSystemPrompt','directorNarratorSystemPrompt','directorNarratorPromptNeedsReview','summarizerSystemPrompt','memoryExtractionPrompt','memoryReorganizePrompt','rewriteSystemPrompt','rewriteRecentMessages','narrationMode','narratorProfileId','directorProfileId','directorSystemPrompt','directorMaxInputTokens','directorMaxOutputTokens','directorRecentTurns','directorFocusLimit']);
export function pickStorySettings(value={}) {
  return Object.fromEntries(STORY_SETTING_KEYS.filter(k=>Object.hasOwn(value,k)).map(k=>[k,structuredClone(value[k])]));
}
export function defaultStorySettings() {
  return {narratorSystemPrompt:prompts.narrator,directorNarratorSystemPrompt:prompts.directorNarratorDefault,directorNarratorPromptNeedsReview:false,summarizerSystemPrompt:prompts.summarizer,memoryExtractionPrompt:prompts.memoryExtraction,memoryReorganizePrompt:prompts.memoryReorganize,rewriteSystemPrompt:prompts.rewrite,rewriteRecentMessages:10,narrationMode:'classic',narratorProfileId:'',directorProfileId:'',directorSystemPrompt:prompts.director,directorMaxInputTokens:20000,directorMaxOutputTokens:4000,directorRecentTurns:5,directorFocusLimit:5};
}
export function explicitStorySettings(value={}) {
  const result={...defaultStorySettings(),...pickStorySettings(value)};
  if(!Object.hasOwn(value,'directorNarratorSystemPrompt')) {
    const custom=typeof value.narratorSystemPrompt==='string' && value.narratorSystemPrompt.trim() && value.narratorSystemPrompt.replace(/\r\n/g,'\n').trimEnd()!==prompts.narrator.trimEnd();
    if(custom){result.directorNarratorSystemPrompt=value.narratorSystemPrompt;result.directorNarratorPromptNeedsReview=true;}
  }
  if(typeof result.directorNarratorPromptNeedsReview!=='boolean')throw new Error('Invalid Director Narrator prompt review flag.');
  if(result.rewriteSystemPrompt==null)result.rewriteSystemPrompt=prompts.rewrite;
  for(const key of STORY_SETTING_KEYS.filter(k=>k.endsWith('Prompt')))if(typeof result[key]!=='string' || !result[key].trim())throw new Error('Story prompt '+key+' must contain text.');
  if(!Number.isSafeInteger(result.rewriteRecentMessages) || result.rewriteRecentMessages<0)throw new Error('Rewrite recent messages must be a nonnegative whole number.');
  if(!['classic','director'].includes(result.narrationMode))throw new Error('Choose Classic or Director mode.');
  if(typeof result.directorProfileId!=='string' || result.directorProfileId.length>200)throw new Error('Invalid Director profile.');
  if(typeof result.narratorProfileId!=='string' || result.narratorProfileId.length>200)throw new Error('Invalid Narrator profile.');
  for(const [key,min,max] of [['directorMaxInputTokens',1000,200000],['directorMaxOutputTokens',256,32000],['directorRecentTurns',1,20],['directorFocusLimit',1,20]])if(!Number.isSafeInteger(result[key]) || result[key]<min || result[key]>max)throw new Error('Invalid '+key+'.');
  return result;
}
export function resolveStorySettings(accountSettings,storySettings) {
  if(!accountSettings)throw new Error('Account settings have not loaded.');
  const values=storySettings?.values ?? storySettings ?? {};
  const combined={...pickStorySettings(accountSettings),...pickStorySettings(values)},resolved=explicitStorySettings(combined);
  return {...structuredClone(accountSettings),...pickStorySettings(values),directorNarratorSystemPrompt:resolved.directorNarratorSystemPrompt,directorNarratorPromptNeedsReview:resolved.directorNarratorPromptNeedsReview};
}
export function changedStoryFields(base,staged) {
  return Object.fromEntries(STORY_SETTING_KEYS.filter(k=>JSON.stringify(base?.[k])!==JSON.stringify(staged?.[k])).map(k=>[k,staged[k]]));
}
export function mergeStorySettings(current,base,changes) {
  for(const key of Object.keys(pickStorySettings(changes)))if(JSON.stringify(current[key])!==JSON.stringify(base[key]))throw new Error('These story prompts changed on another device. Reload and review before saving.');
  return explicitStorySettings({...current,...pickStorySettings(changes)});
}
export function snapshotRevisions(s={}) {return {historyRevision:s.historyRevision ?? 0,loreRevision:s.loreRevision ?? 0,storySettingsRevision:s.storySettingsRevision ?? 0,directorRevision:s.directorRevision ?? 0,directorPending:s.directorPending ?? null};}
export function assertSnapshotRevisions(before,after) {
  if(!after || after.deleting || JSON.stringify(snapshotRevisions(before))!==JSON.stringify(snapshotRevisions(after)))throw new Error('The story changed while copying or exporting. Try again when both devices are idle.');
}

// Recognize old built-in defaults without modifying the original Classic field.
export async function migrateStorySettings(value={}) {
  if(typeof value.directorSystemPrompt==='string' && globalThis.crypto?.subtle) {
    const text=value.directorSystemPrompt.replace(/\r\n/g,'\n').trimEnd();
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(prompts.directorDefaultHashes.split('\n').includes(hash))value={...value,directorSystemPrompt:prompts.director};
  }
  if(!Object.hasOwn(value,'directorNarratorSystemPrompt') && typeof value.narratorSystemPrompt==='string' && value.narratorSystemPrompt.replace(/\r\n/g,'\n').trimEnd()!==prompts.narrator.trimEnd() && globalThis.crypto?.subtle) {
    const known=new Set(prompts.legacyPromptHashes.split('\n').map(line=>line.trim().split(/\s+/)).filter(([key])=>key==='narratorSystemPrompt').map(([,hash])=>hash));
    for(const text of new Set([value.narratorSystemPrompt,value.narratorSystemPrompt.replace(/\r\n/g,'\n').replace(/\n$/,'').trimEnd()])) {
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
      const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      if(known.has(hash))return explicitStorySettings({...value,directorNarratorSystemPrompt:prompts.directorNarratorDefault,directorNarratorPromptNeedsReview:false});
    }
  }
  return explicitStorySettings(value);
}
