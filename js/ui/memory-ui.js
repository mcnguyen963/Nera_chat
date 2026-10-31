import {setIcon} from './icons.js';
import {friendlyError} from '../errors.js';
import {copyText} from './clipboard.js';
const sheets = [];
export function activeSheet() {
  return sheets.findLast(({root}) => root.isConnected !== false && !root.classList.contains('hidden'))?.root ?? null;
}
export function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
export function pendingButton(b, label = 'Working…') {
  const text=b.textContent,children=[...(b.childNodes ?? b.children)],disabled=!!b.disabled;
  b.disabled=true;b.setAttribute('aria-busy','true');b.textContent=label;
  return ()=>{b.disabled=disabled;b.setAttribute('aria-busy','false');if(b.textContent===label){b.replaceChildren(...children);if(!children.length)b.textContent=text;}};
}
export function button(text, action, className = 'btn') {
  const b=node('button',text,className);b.type='button';
  if(text==='×')setIcon(b,'close',className.includes('settings-close')?'Close':'Remove');else if(text.startsWith('‹ '))setIcon(b,'back','Back to '+text.slice(2));
  b.addEventListener('click',async()=>{
    if(b.disabled)return;b.disabled=true;let restore;
    try {
      const result=action(b);
      if(result?.then){b.disabled=false;restore=pendingButton(b,/^save\b/i.test(text)?'Saving…':/^create\b/i.test(text)?'Creating…':/^import\b/i.test(text)?'Importing…':/^export\b/i.test(text)?'Exporting…':/^delete\b/i.test(text)?'Deleting…':'Working…');await result;}
    }catch(e){toast(e);}finally{if(restore)restore();else b.disabled=false;}
  });return b;
}
export function field(label, value = '', { textarea = false, type = 'text' } = {}) { const wrap = node('label',label), input = node(textarea ? 'textarea' : 'input'); if (!textarea) input.type = type; else input.rows = 3; input.value = value ?? ''; wrap.append(input); if (textarea) input.addEventListener('input',() => { input.style.height = 'auto'; input.style.height = input.scrollHeight+'px'; }); return { wrap,input }; }
export function toast(text, action, callback) { text=friendlyError(text); document.querySelector('.toast')?.remove(); const t = node('div',text,'toast action'); t.setAttribute('role','status'); if (action) t.append(button(action,() => { t.remove(); return callback?.(); },'toast-link')); document.body.append(t); setTimeout(() => t.remove(),6000); }
export function sheet(root,title,{ close = () => true, className = '', back, compact = false } = {}) {
  const previousIndex = sheets.findIndex(entry => entry.root === root), previous = sheets[previousIndex];
  const covered = previous && activeSheet() !== root;
  root._sheetCleanup?.();
  const opener = covered ? previous.opener : document.activeElement, entry = {root,opener};
  if (covered) sheets.splice(previousIndex,0,entry); else sheets.push(entry);
  root.classList.toggle('compact-overlay', compact);
  root.replaceChildren(); root.classList.remove('hidden'); root.setAttribute('aria-hidden','false');
  const backdrop = node('div',null,'settings-backdrop'), dialog = node('div',null,'settings-dialog sheet '+className+(compact ? ' compact-sheet' : '')), header = node('header',null,'settings-header');
  const label = node('h2',title); label.id = root.id+'-title'; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby',label.id); dialog.tabIndex = -1;
  const cleanup=()=>{document.removeEventListener('keydown',keys);observer?.disconnect();const index=sheets.indexOf(entry);if(index!==-1)sheets.splice(index,1);delete root._sheetCleanup;};
  let observer,hidden=false;
  const hide = () => {
    if(hidden || root._sheetCleanup!==cleanup)return true;
    if(close()===false)return false;
    const restoreFocus=activeSheet()===root;
    hidden=true;root.classList.add('hidden');root.setAttribute('aria-hidden','true');root.replaceChildren();cleanup();
    if(restoreFocus){
      const underneath=activeSheet() ?? document.querySelector('.settings-overlay:not(.hidden)');
      const target=opener?.isConnected!==false && (!underneath || underneath.contains?.(opener)) ? opener : underneath?.querySelector('.settings-dialog');
      target?.focus?.({preventScroll:true});
      if(underneath?.contains?.(document.activeElement)===false)underneath.querySelector('.settings-close')?.focus?.({preventScroll:true});
    }
    document.dispatchEvent(new CustomEvent('ui-surface-change'));return true;
  };
  const goBack = () => back ? back(hide) : hide();
  const keys = e => {
    if (e.defaultPrevented || activeSheet() !== root || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { e.preventDefault(); goBack(); }
    if (e.key !== 'Tab') return;
    const all = [...dialog.querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]')].filter(e => !e.disabled && e.getClientRects().length);
    if (!all.length) { e.preventDefault(); dialog.focus(); return; }
    if (e.shiftKey && (document.activeElement === all[0] || document.activeElement === dialog)) { e.preventDefault(); all.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === all.at(-1)) { e.preventDefault(); all[0].focus(); }
  };
  header.append(label,button('×',hide,'settings-close')); dialog.append(header); root.append(backdrop,dialog);
  backdrop.addEventListener('click',hide); document.addEventListener('keydown',keys);root._sheetCleanup=cleanup;if(typeof MutationObserver==='function'){observer=new MutationObserver(()=>{if(!root.isConnected)cleanup();});observer.observe(document.body,{childList:true,subtree:true});}if(activeSheet()===root && !document.querySelector('dialog[open]'))dialog.focus(); document.dispatchEvent(new CustomEvent('ui-surface-change'));
  dialog.addEventListener('toggle',event=>{if(event.target.tagName==='DETAILS'){const summary=event.target.querySelector('summary');summary?.setAttribute('aria-expanded',String(event.target.open));}},true);
  return { dialog,hide,header };
}
export function subSheet(title,opts) { const root = node('section',null,'settings-overlay memory-sub-sheet'); root.id = 'memory-dialog-'+Date.now(); document.body.append(root); const s = sheet(root,title,{ ...opts,close:() => { if (opts?.close?.() === false) return false; setTimeout(() => root.remove(),0); return true; } }); return s; }
export function download(text,name,type = 'text/plain') { const url = URL.createObjectURL(new Blob([text],{ type })), link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
export const copy = copyText;
