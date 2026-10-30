import {getPref,setPref} from './local-pref.js';

function storageKey(owner,endpoint) {
  if(!owner)throw new Error('Sign in before saving an embedding API key.');
  return 'nera.embedding-key.'+JSON.stringify([owner,endpoint]);
}
export function getEmbeddingKey(owner,endpoint) {
  return owner ? getPref(storageKey(owner,endpoint),'') : '';
}
export function saveEmbeddingKey(owner,endpoint,key) {
  const name=storageKey(owner,endpoint),value=String(key ?? '').trim();
  if(!value){try{localStorage.removeItem(name);}catch{throw new Error('Could not remove the API key from this device.');}return;}
  if(!setPref(name,value))throw new Error('Could not save the API key on this device.');
}
