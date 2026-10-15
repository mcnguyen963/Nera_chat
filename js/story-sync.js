// Optional sync boundary for settings, exports and maintenance. No Firebase imports.
let flush=async()=>{};
export function configureStorySync(handler){flush=handler;}
export function flushStory(sid){return sid?flush(sid):Promise.resolve();}
