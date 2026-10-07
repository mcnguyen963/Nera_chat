import {clearChatCache} from './chat-cache.js';
export function accountCacheKeys(uid,keys) {return keys.filter(k=>k===`roleplay-settings:${uid}` || k.startsWith('nera.settings.') || k.startsWith('nera.lore.seen.'));}
export async function clearAccountCaches(uid) {
  await clearChatCache(uid);
  try {for(const key of accountCacheKeys(uid,Object.keys(localStorage)))localStorage.removeItem(key);}catch {}
}
