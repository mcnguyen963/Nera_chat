import { prompts } from './system-prompts.js';
export const STORY_SETTINGS_VERSION=1;
export const STORY_SETTING_KEYS=Object.freeze(['narratorSystemPrompt','summarizerSystemPrompt','memoryExtractionPrompt','memoryReorganizePrompt','rewriteSystemPrompt','rewriteRecentMessages']);
export function pickStorySettings(value={}) {
  return Object.fromEntries(STORY_SETTING_KEYS.filter(k=>Object.hasOwn(value,k)).map(k=>[k,structuredClone(value[k])]));
}
export function defaultStorySettings() {
  return {narratorSystemPrompt:prompts.narrator,summarizerSystemPrompt:prompts.summarizer,memoryExtractionPrompt:prompts.memoryExtraction,memoryReorganizePrompt:prompts.memoryReorganize,rewriteSystemPrompt:prompts.rewrite,rewriteRecentMessages:10};
}
export function explicitStorySettings(value={}) {
  const result={...defaultStorySettings(),...pickStorySettings(value)};
  if(result.rewriteSystemPrompt==null)result.rewriteSystemPrompt=prompts.rewrite;
  for(const key of STORY_SETTING_KEYS.filter(k=>k.endsWith('Prompt')))if(typeof result[key]!=='string' || !result[key].trim())throw new Error('Story prompt '+key+' must contain text.');
  if(!Number.isSafeInteger(result.rewriteRecentMessages) || result.rewriteRecentMessages<0)throw new Error('Rewrite recent messages must be a nonnegative whole number.');
  return result;
}
export function resolveStorySettings(accountSettings,storySettings) {
  if(!accountSettings)throw new Error('Account settings have not loaded.');
  return {...structuredClone(accountSettings),...pickStorySettings(storySettings?.values ?? storySettings ?? {})};
}
export function changedStoryFields(base,staged) {
  return Object.fromEntries(STORY_SETTING_KEYS.filter(k=>JSON.stringify(base?.[k])!==JSON.stringify(staged?.[k])).map(k=>[k,staged[k]]));
}
export function mergeStorySettings(current,base,changes) {
  for(const key of Object.keys(pickStorySettings(changes)))if(JSON.stringify(current[key])!==JSON.stringify(base[key]))throw new Error('These story prompts changed on another device. Reload and review before saving.');
  return explicitStorySettings({...current,...pickStorySettings(changes)});
}
export function snapshotRevisions(s={}) {return {historyRevision:s.historyRevision ?? 0,loreRevision:s.loreRevision ?? 0,storySettingsRevision:s.storySettingsRevision ?? 0};}
export function assertSnapshotRevisions(before,after) {
  if(!after || after.deleting || JSON.stringify(snapshotRevisions(before))!==JSON.stringify(snapshotRevisions(after)))throw new Error('The story changed while copying or exporting. Try again when both devices are idle.');
}
