import {setIcon} from './icons.js';
import {copyText} from './clipboard.js';

export function displayedMessageText(message) {
  const body = message?.querySelector('.msg-content');
  return body ? (body.innerText ?? body.textContent ?? '') : '';
}
// Floating header and composer controls overlay the list. Target the reading
// area between them, so an obscured message control still qualifies for reachable Copy.
export function readingViewport(list, header, composer) {
  const top = Math.min(list.bottom, Math.max(list.top, header?.bottom ?? list.top));
  const bottom = Math.max(top, Math.min(list.bottom, composer?.top ?? list.bottom));
  return {top, bottom, left:list.left, right:list.right, width:list.width, height:Math.max(0, bottom - top)};
}
export function eligibleFloatingCopy({viewport, message, control, completed = true, blocked = false}) {
  if (blocked || !completed || !message || !control || viewport.height <= 0) return false;
  const middle = viewport.top + viewport.height / 2;
  return message.height > viewport.height && message.top <= middle && message.bottom >= middle &&
    (control.top < viewport.top || control.bottom > viewport.bottom);
}
export async function copyDisplayedMessage(message, control, copy = copyText) {
  await copy(displayedMessageText(message));
  message.classList.add('copied');
  const label = control.dataset.copyLabel || control.dataset.iconLabel || 'Copy message';
  control.dataset.copyLabel = label;
  setIcon(control, 'check', 'Copied');
  setTimeout(() => { message.classList.remove('copied'); setIcon(control, 'copy', label); }, 1400);
}

// Hit-test the reading midpoint. Work is bounded by the elements at two points,
// never by the number of messages in the story.
export function initFloatingCopy({list, button, editing, onError, doc = document, frame = requestAnimationFrame}) {
  if (!button || !doc.elementsFromPoint) return;
  let queued = false, target = null;
  const update = () => {
    queued = false;
    const blocked = editing() || doc.getSelection()?.isCollapsed === false ||
      !!doc.querySelector('.settings-overlay:not(.hidden), dialog[open], .top-menu:not([hidden]), .message-menu[open]') ||
      doc.body.classList.contains('sidebar-open');
    const viewport = readingViewport(list.getBoundingClientRect(), doc.querySelector('.top-bar')?.getBoundingClientRect?.(), doc.querySelector('.composer')?.getBoundingClientRect?.());
    target = null;
    if (!blocked && viewport.height > 0) {
      const y = viewport.top + viewport.height / 2;
      const gutter = parseFloat(window.getComputedStyle?.(list)?.paddingRight) || 12;
      for (const x of [viewport.left + viewport.width / 2, viewport.right - gutter - 8]) {
        const message = doc.elementsFromPoint(x, y).map(n => n.closest?.('.msg')).find(n => n && list.contains(n));
        const control = message?.querySelector('.message-copy');
        if (eligibleFloatingCopy({viewport, message:message?.getBoundingClientRect(), control:control?.getBoundingClientRect(), completed:message?.dataset.copyReady === 'true'})) { target = message; break; }
      }
    }
    button.hidden = !target;
  };
  const schedule = () => { if (!queued) { queued = true; frame(update); } };
  button.addEventListener('pointerdown', e => e.preventDefault());
  button.addEventListener('click', () => { update(); if (target) void copyDisplayedMessage(target, button).catch(onError); });
  list.addEventListener('scroll', schedule, {passive:true});
  doc.addEventListener('selectionchange', schedule);
  doc.addEventListener('ui-surface-change', schedule);
  doc.addEventListener('toggle', schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(list);
  if (typeof MutationObserver === 'function') {
    new MutationObserver(schedule).observe(list, {childList:true});
    const surfaces = new MutationObserver(schedule);
    doc.querySelectorAll('.settings-overlay').forEach(root => surfaces.observe(root, {attributes:true,attributeFilter:['class','aria-hidden']}));
    surfaces.observe(doc.body, {childList:true,attributes:true,attributeFilter:['class']});
  }
  schedule();
  return schedule;
}
