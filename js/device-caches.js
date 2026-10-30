import {clearChatCache} from './chat-cache.js';
import {clearLoreSemanticAccount} from './lore-semantic.js';
import {clearRecallAccount} from './history-recall-storage.js';
import {clearVectorCloudAccount} from './vector-cloud-cache.js';
export function accountCacheKeys(uid,keys) {return keys.filter(k=>k===`roleplay-settings:${uid}` || k.startsWith('nera.settings.') || k.startsWith('nera.lore.seen.'));}
export async function clearAccountCaches(uid) {
  try { await clearRecallAccount(uid); } catch (error) { console.error('Could not clear historical index:',error); }
  try { await clearVectorCloudAccount(uid); } catch (error) { console.error('Could not clear vector sync cache:',error); }
  try { await clearLoreSemanticAccount(uid); } catch (error) { console.error('Could not clear semantic index:',error); }
  try { await clearChatCache(uid); }
  catch (error) { console.error('Could not clear chat cache:',error); }
  try {
    for(const key of accountCacheKeys(uid,Object.keys(localStorage))) {
      try {localStorage.removeItem(key);} catch (error) {console.error('Could not clear local settings:',error);}
    }
  } catch {}
}
