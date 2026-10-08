import {recentErrors} from './errors.js';
export function runningVersion(doc=document){return {sha:doc.querySelector('meta[name="nera-version"]')?.content ?? 'local',builtAt:doc.querySelector('meta[name="nera-built-at"]')?.content ?? ''};}
export function diagnostics(state,{version=runningVersion(),agent=navigator.userAgent}={}){
 const ms=state.session?.memoryState ?? state.memoryState ?? {};
 return {version,userAgent:agent,sessionId:state.sessionId ?? null,memory:{extractedThroughOrder:ms.extractedThroughOrder ?? null,failureStreak:ms.failureStreak ?? 0,paused:!!ms.paused,needsRebuild:!!ms.needsRebuild},errors:recentErrors()};
}
export const versionChanged=(current,next)=>!!next && next.slice(0,8)!==current.slice(0,8);
export function initVersion(){
 const running=runningVersion(),label=document.getElementById('app-version');
 if(label)label.textContent=running.sha==='local'?'Local version':`v${running.sha.slice(0,8)} · ${running.builtAt.slice(0,10)}`;
 let checking=false;
 const check=async()=>{if(checking || running.sha==='local')return;checking=true;try{
  const r=await fetch(new URL('../version.json',import.meta.url),{cache:'no-cache'});if(!r.ok)return;const next=await r.json();if(!versionChanged(running.sha,next.sha))return;
  if(document.getElementById('new-version-banner'))return;
  const banner=document.createElement('div');banner.id='new-version-banner';banner.className='toast';banner.textContent='A new version is available — ';
  const reload=document.createElement('button');reload.type='button';reload.className='btn small';reload.textContent='Reload';reload.addEventListener('click',()=>location.reload());banner.append(reload);document.body.append(banner);
 }catch{/* Retry on the next visibility change. */}finally{checking=false;}};
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});window.addEventListener('focus',()=>void check());void check();
}
