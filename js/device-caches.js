import {clearChatCache} from './chat-cache.js';
export function accountCacheKeys(uid,keys) {return keys.filter(k=>k===`roleplay-settings:${uid}` || k.startsWith('nera.settings.') || k.startsWith('nera.lore.seen.'));}
export async function clearAccountCaches(uid) {
  try { await clearChatCache(uid); }
  catch (error) { console.error('Could not clear chat cache:',error); }
  try {
    for(const key of accountCacheKeys(uid,Object.keys(localStorage))) {
      try {localStorage.removeItem(key);} catch (error) {console.error('Could not clear local settings:',error);}
    }
  } catch {}
}
