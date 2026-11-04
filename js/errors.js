export class StoryDeleted extends Error {constructor(){super('This story was deleted.');this.name='StoryDeleted';}}
export function assertStory(session){if(!session || session.deleting)throw new StoryDeleted();return session;}
const messages={
 'resource-exhausted':"The app's free daily database quota is used up. It resets at midnight Pacific time.",
 'permission-denied':'This account is not allowed to use the app (or you were signed out).',
 unavailable:'Offline — changes will retry.'
};
const codeOf=e=>typeof e?.code==='string' ? e.code.match(/^(?:firestore\/)?(resource-exhausted|permission-denied|unavailable)$/)?.[1] : undefined;
export function friendlyError(e){return messages[codeOf(e)] ?? (typeof e==='string' ? e : e?.message || String(e));}
const recent=[];
export function recordError(e){
 // Arbitrary provider errors can contain secrets or story text: diagnostics keep
 // their category, never their free-form text.
 const code=codeOf(e),name=/^[A-Za-z]+Error$/.test(e?.name ?? '') ? e.name : 'Error';
 recent.push({at:new Date().toISOString(),code:Object.hasOwn(messages,code)?code:'unknown',name,message:messages[code] ?? 'Unexpected '+name});if(recent.length>20)recent.shift();
}
export function recentErrors(){return recent.map(e=>({...e}));}
export function installErrorHandlers({target=window,show,now=()=>Date.now()}={}){
 let last=-Infinity;const handle=e=>{if(/^ResizeObserver loop/.test(String(e.message ?? e.error?.message ?? ''))){console.warn(e.message ?? e.error.message);return;}const error=e.reason ?? e.error ?? e;recordError(error);if(now()-last>=10000){last=now();show('Something went wrong: '+friendlyError(error));}};
 target.addEventListener('error',handle);target.addEventListener('unhandledrejection',handle);
}
