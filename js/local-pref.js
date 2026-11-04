export function getPref(key,fallback=null){try{return localStorage.getItem(key) ?? fallback;}catch{return fallback;}}
export function setPref(key,value){try{localStorage.setItem(key,String(value));return true;}catch{return false;}}
