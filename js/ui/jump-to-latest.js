import {readingViewport} from './message-copy.js';

export function initJumpToLatest({list, button, onJump, doc = document, frame = requestAnimationFrame}) {
  if (!button) return;
  let queued = false;
  const composer = doc.getElementById('composer-shell');
  const update = () => {
    queued = false;
    button.hidden = true;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 60) return;
    // Count actual messages, skipping notices and checkpoint dividers.
    let count = 0, boundary = null;
    for (let node = list.lastElementChild; node; node = node.previousElementSibling) {
      if (!node.matches('.msg.user, .msg.assistant, .msg.summary')) continue;
      boundary = node;
      if (++count === 3) break;
    }
    if (!boundary || count < 3) return;
    const viewport = readingViewport(list.getBoundingClientRect(),
      doc.querySelector('.top-bar')?.getBoundingClientRect(), composer?.getBoundingClientRect());
    button.hidden = viewport.height <= 0 || boundary.getBoundingClientRect().top < viewport.bottom;
  };
  const schedule = () => { if (!queued) { queued = true; frame(update); } };
  button.addEventListener('click', () => { onJump(); schedule(); });
  list.addEventListener('scroll', schedule, {passive:true});
  list.addEventListener('toggle', schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    if (composer) observer.observe(composer);
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(schedule).observe(list, {childList:true, subtree:true, characterData:true});
  }
  schedule();
}
