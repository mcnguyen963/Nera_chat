import {friendlyError} from '../errors.js';
import {copyText} from './clipboard.js';
export function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
export function button(text, action, className = 'btn') { const b = node('button',text,className); b.type = 'button'; b.addEventListener('click',async () => { if(b.disabled)return;b.disabled=true;try { await action(b); } catch (e) { toast(e); } finally {b.disabled=false;} }); return b; }
export function field(label, value = '', { textarea = false, type = 'text' } = {}) { const wrap = node('label',label), input = node(textarea ? 'textarea' : 'input'); if (!textarea) input.type = type; else input.rows = 3; input.value = value ?? ''; wrap.append(input); if (textarea) input.addEventListener('input',() => { input.style.height = 'auto'; input.style.height = input.scrollHeight+'px'; }); input.addEventListener('focus',() => requestAnimationFrame(() => input.scrollIntoView({ block:'nearest' }))); return { wrap,input }; }
export function toast(text, action, callback) { text=friendlyError(text); document.querySelector('.toast')?.remove(); const t = node('div',text,'toast action'); if (action) t.append(button(action,() => { t.remove(); return callback?.(); },'toast-link')); document.body.append(t); setTimeout(() => t.remove(),6000); }
export function sheet(root,title,{ close = () => true, className = '', back } = {}) {
  root._sheetCleanup?.();
  const opener = document.activeElement;
  root.replaceChildren(); root.classList.remove('hidden'); root.setAttribute('aria-hidden','false');
  const backdrop = node('div',null,'settings-backdrop'), dialog = node('div',null,'settings-dialog sheet '+className), header = node('header',null,'settings-header');
  const label = node('h2',title); label.id = root.id+'-title'; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby',label.id); dialog.tabIndex = -1;
  const cleanup=()=>{document.removeEventListener('keydown',keys);observer?.disconnect();delete root._sheetCleanup;};
  let observer;
  const hide = () => { if (close() === false) return false; root.classList.add('hidden'); root.setAttribute('aria-hidden','true'); root.replaceChildren(); cleanup(); opener?.focus?.(); return true; };
  const goBack = () => back ? back(hide) : hide();
  const keys = e => {
    if (root.classList.contains('hidden') || document.querySelector('.memory-sub-sheet:not(.hidden)') && !root.classList.contains('memory-sub-sheet')) return;
    if (e.key === 'Escape') { e.preventDefault(); goBack(); }
    if (e.key !== 'Tab') return;
    const all = [...dialog.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(e => !e.disabled && e.getClientRects().length);
    if (!all.length) { e.preventDefault(); dialog.focus(); return; }
    if (e.shiftKey && (document.activeElement === all[0] || document.activeElement === dialog)) { e.preventDefault(); all.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === all.at(-1)) { e.preventDefault(); all[0].focus(); }
  };
  header.append(label,button('×',hide,'settings-close')); dialog.append(header); root.append(backdrop,dialog);
  backdrop.addEventListener('click',hide); document.addEventListener('keydown',keys);root._sheetCleanup=cleanup;if(typeof MutationObserver==='function'){observer=new MutationObserver(()=>{if(!root.isConnected)cleanup();});observer.observe(document.body,{childList:true,subtree:true});} dialog.focus();
  dialog.addEventListener('toggle',event=>{if(event.target.tagName==='DETAILS'){const summary=event.target.querySelector('summary');summary?.setAttribute('aria-expanded',String(event.target.open));}},true);
  return { dialog,hide,header };
}
export function subSheet(title,opts) { const root = node('section',null,'settings-overlay memory-sub-sheet'); root.id = 'memory-dialog-'+Date.now(); document.body.append(root); const s = sheet(root,title,{ ...opts,close:() => { if (opts?.close?.() === false) return false; setTimeout(() => root.remove(),0); return true; } }); return s; }
export function download(text,name,type = 'text/plain') { const url = URL.createObjectURL(new Blob([text],{ type })), link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
export const copy = copyText;
