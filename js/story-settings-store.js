import {loadStoryData,saveStoryData} from './chat-cache.js';
import {flushStory} from './story-sync.js';
import {doc,runTransaction,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {db} from './db.js';
import {currentUid} from './auth.js';
import {state} from './state.js';
import {assertStory} from './errors.js';
import {resolveModelProfile} from './model-profiles.js';
import {STORY_SETTINGS_VERSION,migrateStorySettings,defaultStorySettings,resolveStorySettings,mergeStorySettings,pickStorySettings} from './story-settings.js';
const parent=(sid,uid=currentUid())=>doc(db,'users',uid,'sessions',sid);
const target=(sid,uid=currentUid())=>doc(db,'users',uid,'sessions',sid,'storySettings','current');
const seedRef=(uid=currentUid())=>doc(db,'users',uid,'settings','storyMigration');
const cache=new Map();let epoch=0;
async function readDocument(data){if(![1,2,3,4,5,STORY_SETTINGS_VERSION].includes(data?.version) || !Number.isSafeInteger(data.revision) || data.revision<1)throw new Error('Unsupported story settings. Reload and review this story.');return {...data,values:await migrateStorySettings(data.values)};}
export async function preserveLegacyStorySeed(accountSettings,{owner=currentUid(),check=()=>{if(owner!==currentUid())throw new Error('Account changed; story prompt migration cancelled.');}}={}) {
  const ref=seedRef(owner);check();
  return runTransaction(db,async tx=>{
    check();const saved=await tx.get(ref);check();
    if(saved.exists())return saved.data().values;
    const values=await migrateStorySettings(accountSettings);check();
    tx.set(ref,{version:STORY_SETTINGS_VERSION,values,createdAt:serverTimestamp()});
    return values;
  });
}
export async function ensureStorySettings(sid,uid=currentUid(),{cacheResult=true}={}) {
  const ref=target(sid,uid),loadEpoch=epoch;
  const result=await runTransaction(db,async tx=>{
    const session=assertStory((await tx.get(parent(sid,uid))).data()),saved=await tx.get(ref);
    if(saved.exists()){const data=await readDocument(saved.data());if(data.revision!==(session.storySettingsRevision ?? 0))throw new Error('Story settings revisions disagree. Reload and review before generating.');return data;}
    const seed=await tx.get(seedRef(uid));
    if(!seed.exists())throw new Error('Story prompt migration has not loaded from the server. Reload before generating.');
    const result={version:STORY_SETTINGS_VERSION,revision:1,values:await migrateStorySettings(seed.data().values)};
    tx.set(ref,result);tx.update(parent(sid,uid),{storySettingsRevision:1});return result;
  });
  if(cacheResult && loadEpoch===epoch && uid===currentUid())cache.set(uid+':'+sid,result);return structuredClone(result);
}
export async function writeInitialStorySettings(sid,values=defaultStorySettings(),uid=currentUid()) {
  const result={version:STORY_SETTINGS_VERSION,revision:1,values:await migrateStorySettings(values)};
  await runTransaction(db,async tx=>{
    assertStory((await tx.get(parent(sid,uid))).data());
    tx.set(target(sid,uid),result);tx.update(parent(sid,uid),{storySettingsRevision:1});
  });
  cache.set(uid+':'+sid,result);return result;
}
export async function saveStorySettings(sid,base,changes) {
  const uid=currentUid();
  await flushStory(sid);
  let committedPatch=null;
  const result=await runTransaction(db,async tx=>{
    const session=assertStory((await tx.get(parent(sid,uid))).data()),saved=await tx.get(target(sid,uid));
    if(!saved.exists())throw new Error('Story settings have not loaded. Reload before saving.');
    const current=await readDocument(saved.data()),allowed=pickStorySettings(changes);
    if(current.revision!==(session.storySettingsRevision ?? 0))throw new Error('Story settings revisions disagree. Reload and review before saving.');
    const values=mergeStorySettings(current.values,base,allowed);
    if(!Object.keys(allowed).length)return current;
    const modeChanged=values.narrationMode!==current.values.narrationMode;
    if(modeChanged && session.directorPending)throw new Error('Finish or discard pending Director narration before switching modes.');
    if(modeChanged && values.narrationMode==='director' && session.memory?.calendar?.mode==='modern' && !session.directorState)throw new Error('Review live state and save its modern date and HH:mm time before enabling Director mode.');
    const revision=(session.storySettingsRevision ?? 0)+1;
    const result={version:STORY_SETTINGS_VERSION,revision,values};
    committedPatch={storySettingsRevision:revision,...(modeChanged && values.narrationMode==='director' && session.directorState && session.directorStateHistoryOrder!==(session.nextOrder ?? 0) ? {directorNeedsReview:true} : {})};
    tx.set(target(sid,uid),result);tx.update(parent(sid,uid),{...committedPatch,updatedAt:serverTimestamp()});return result;
  });
  cache.set(uid+':'+sid,result);void saveStoryData(uid,sid,{storySettings:result});
  if(state.sessionId===sid && uid===currentUid()){state.storySettings=result;emit(committedPatch);}
  return result;
}
function emit(sessionPatch=null){if(typeof document!=='undefined')document.dispatchEvent(new CustomEvent('story-settings-changed',{detail:{sessionPatch}}));}
export async function selectStorySettings(sid,{force=false}={}) {
  const run=++epoch,uid=currentUid();
  state.storySettings=null;state.storySettingsId=sid;state.storySettingsLoadFailed=false;emit();
  if(!sid)return;
  try {
    const stored=force?null:await loadStoryData(uid,sid);
    const loaded=(!force && cache.get(uid+':'+sid)) || (stored?.storySettings ? await readDocument(stored.storySettings) : await ensureStorySettings(sid,uid));
    if(run!==epoch || uid!==currentUid() || state.sessionId!==sid)return;
    state.storySettings=loaded;cache.set(uid+':'+sid,loaded);void saveStoryData(uid,sid,{storySettings:loaded});emit();
  }catch(error){if(run===epoch){state.storySettingsLoadFailed=true;emit();}throw error;}
}
export function invalidateStorySettingsLoads(){++epoch;}
export async function readStorySettingsRefresh(sid){return ensureStorySettings(sid,currentUid(),{cacheResult:false});}
export function applyStorySettingsRefresh(sid,loaded){
  ++epoch;cache.set(currentUid()+':'+sid,loaded);state.storySettingsId=sid;state.storySettings=loaded;state.storySettingsLoadFailed=false;
}
export function effectiveActiveSettings() {
  if(!state.sessionId || state.storySettingsId!==state.sessionId || !state.storySettings || state.storySettingsLoadFailed)throw new Error('Story prompts have not loaded. Reload the story before generating.');
  const settings=resolveStorySettings(state.settings,state.storySettings);
  return {...resolveModelProfile(settings,settings.narratorProfileId,{role:'Narrator'}),_storySettingsRevision:state.storySettings.revision};
}
