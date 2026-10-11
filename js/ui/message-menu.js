import {setIcon} from './icons.js';
let openMenu = null;
export function messageMenu(actions) {
  const menu = document.createElement('details'); menu.className = 'message-menu';
  const trigger = document.createElement('summary'); setIcon(trigger, 'more', 'Message actions');
  trigger.setAttribute('aria-expanded', 'false');
  const backdrop = document.createElement('div'); backdrop.className = 'message-menu-backdrop';
  const panel = document.createElement('div'); panel.className = 'message-menu-panel';
  panel.setAttribute('aria-label', 'Message actions');
  panel.append(...actions); menu.append(trigger, backdrop, panel);
  const close = (restore = false) => { menu.open = false; if (openMenu === menu) openMenu = null; if (restore) trigger.focus({preventScroll:true}); };
  backdrop.addEventListener('click', event => { event.stopPropagation(); close(true); });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    // Do not steal focus from an editor opened by the action.
    close(panel.contains(document.activeElement));
  });
  menu.addEventListener('toggle', () => {
    trigger.setAttribute('aria-expanded', String(menu.open));
    if (menu.open) { if (openMenu && openMenu !== menu) openMenu.open = false; openMenu = menu; }
    else if (openMenu === menu) openMenu = null;
    document.dispatchEvent(new CustomEvent('ui-surface-change'));
  });
  menu.addEventListener('keydown', event => {
    if (!menu.open || event.key !== 'Tab') return;
    const items = [trigger, ...panel.querySelectorAll('button')].filter(n => !n.disabled && n.getClientRects().length);
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); trigger.focus(); }
  });
  return menu;
}
export function initMessageMenus() {
  document.addEventListener('click', event => { if (openMenu && !openMenu.contains(event.target)) { openMenu.open = false; openMenu = null; } });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !openMenu) return;
    const menu = openMenu; menu.open = false; openMenu = null; menu.querySelector('summary').focus({preventScroll:true});
  });
}
