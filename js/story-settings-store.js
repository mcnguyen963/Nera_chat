import {doc,runTransaction,onSnapshot,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {db} from './db.js';
import {currentUid} from './auth.js';
import {state} from './state.js';
import {assertStory} from './errors.js';
import {STORY_SETTINGS_VERSION,migrateStorySettings,defaultStorySettings,resolveStorySettings,mergeStorySettings,pickStorySettings} from './story-settings.js';
const parent=(sid,uid=currentUid())=>doc(db,'users',uid,'sessions',sid);
const target=(sid,uid=currentUid())=>doc(db,'users',uid,'sessions',sid,'storySettings','current');
const seedRef=(uid=currentUid())=>doc(db,'users',uid,'settings','storyMigration');
const cache=new Map();let unsubscribe=null,epoch=0,snapshotRun=0;
async function readDocument(data){if(![1,2,STORY_SETTINGS_VERSION].includes(data?.version) || !Number.isSafeInteger(data.revision) || data.revision<1)throw new Error('Unsupported story settings. Reload and review this story.');return {...data,values:await migrateStorySettings(data.values)};}
export async function preserveLegacyStorySeed(accountSettings) {
  const uid=currentUid(),ref=seedRef(uid);
  return runTransaction(db,async tx=>{
    const saved=await tx.get(ref);
    if(saved.exists())return saved.data().values;
    const values=await migrateStorySettings(accountSettings);
    tx.set(ref,{version:STORY_SETTINGS_VERSION,values,createdAt:serverTimestamp()});
    return values;
  });
}
export async function ensureStorySettings(sid,uid=currentUid()) {
  const ref=target(sid,uid);
  const result=await runTransaction(db,async tx=>{
    const session=assertStory((await tx.get(parent(sid,uid))).data()),saved=await tx.get(ref);
    if(saved.exists()){const data=await readDocument(saved.data());if(data.revision!==(session.storySettingsRevision ?? 0))throw new Error('Story settings revisions disagree. Reload and review before generating.');return data;}
    const seed=await tx.get(seedRef(uid));
    if(!seed.exists())throw new Error('Story prompt migration has not loaded from the server. Reload before generating.');
    const result={version:STORY_SETTINGS_VERSION,revision:1,values:await migrateStorySettings(seed.data().values)};
    tx.set(ref,result);tx.update(parent(sid,uid),{storySettingsRevision:1});return result;
  });
  cache.set(uid+':'+sid,result);return structuredClone(result);
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
  const result=await runTransaction(db,async tx=>{
    const session=assertStory((await tx.get(parent(sid,uid))).data()),saved=await tx.get(target(sid,uid));
    if(!saved.exists())throw new Error('Story settings have not loaded. Reload before saving.');
    const current=await readDocument(saved.data()),allowed=pickStorySettings(changes);
    if(current.revision!==(session.storySettingsRevision ?? 0))throw new Error('Story settings revisions disagree. Reload and review before saving.');
    const values=mergeStorySettings(current.values,base,allowed);
    if(!Object.keys(allowed).length)return current;
    const modeChanged=values.narrationMode!==current.values.narrationMode;
    if(modeChanged && session.directorPending)throw new Error('Finish or discard pending Director narration before switching modes.');
    if(modeChanged && values.narrationMode==='director' && session.memory?.calendar?.mode==='modern' && !session.directorState)throw new Error('Review live state and enter game hours 1–24 before enabling Director mode for a modern-clock story.');
    const revision=(session.storySettingsRevision ?? 0)+1;
    const result={version:STORY_SETTINGS_VERSION,revision,values};
    tx.set(target(sid,uid),result);tx.update(parent(sid,uid),{storySettingsRevision:revision,...(modeChanged && values.narrationMode==='director' && session.directorState && session.directorStateHistoryOrder!==(session.nextOrder ?? 0) ? {directorNeedsReview:true} : {}),updatedAt:serverTimestamp()});return result;
  });
  cache.set(uid+':'+sid,result);
  if(state.sessionId===sid && uid===currentUid()){state.storySettings=result;emit();}
  return result;
}
function emit(){if(typeof document!=='undefined')document.dispatchEvent(new CustomEvent('story-settings-changed'));}
export async function selectStorySettings(sid) {
  const run=++epoch,uid=currentUid();unsubscribe?.();unsubscribe=null;
  state.storySettings=null;state.storySettingsId=sid;state.storySettingsLoadFailed=false;emit();
  if(!sid)return;
  try {
    const loaded=await ensureStorySettings(sid,uid);
    if(run!==epoch || uid!==currentUid() || state.sessionId!==sid)return;
    state.storySettings=loaded;emit();
    unsubscribe=onSnapshot(target(sid,uid),async snap=>{
      if(run!==epoch || uid!==currentUid() || snap.metadata?.fromCache || snap.metadata?.hasPendingWrites)return;
      const delivery=++snapshotRun;
      if(!snap.exists()){state.storySettings=null;state.storySettingsLoadFailed=true;emit();return;}
      let data;try{data=await readDocument(snap.data());}catch{if(delivery===snapshotRun && run===epoch){state.storySettings=null;state.storySettingsLoadFailed=true;emit();}return;}if(delivery!==snapshotRun || run!==epoch || uid!==currentUid() || state.sessionId!==sid)return;cache.set(uid+':'+sid,data);state.storySettings=data;state.storySettingsLoadFailed=false;emit();
    },()=>{if(run===epoch){++snapshotRun;state.storySettingsLoadFailed=true;state.storySettings=null;emit();}});
  }catch(error){if(run===epoch){state.storySettingsLoadFailed=true;emit();}throw error;}
}
export function effectiveActiveSettings() {
  if(!state.sessionId || state.storySettingsId!==state.sessionId || !state.storySettings || state.storySettingsLoadFailed)throw new Error('Story prompts have not loaded. Reload the story before generating.');
  return {...resolveStorySettings(state.settings,state.storySettings),_storySettingsRevision:state.storySettings.revision};
}
