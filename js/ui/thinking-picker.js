export function initThinkingPicker({button, menu, select, doc = document}) {
  if (!button || !menu || !select) return null;
  const items = Array.from(menu.querySelectorAll('[data-thinking]'));
  const composer = button.closest('.composer-box');
  const close = ({restore = false} = {}) => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    composer?.classList?.remove('thinking-open');
    if (restore) button.focus({preventScroll:true});
  };
  const sync = (value, label) => {
    button.setAttribute('aria-label', label);
    button.title = label;
    for (const item of items) item.setAttribute('aria-checked', String(item.dataset.thinking === value));
  };
  // Avoid moving a collapsed button between pointerdown and click when focus expands the composer.
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (button.disabled) return;
    if (!menu.hidden) return close({restore:true});
    composer?.classList?.add('thinking-open');
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items.find(item => item.dataset.thinking === select.value) || items[0])?.focus();
  });
  for (const item of items) item.addEventListener('click', () => {
    select.value = item.dataset.thinking;
    select.dispatchEvent(new Event('change', {bubbles:true}));
    close({restore:true});
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close({restore:true}); return; }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || !items.length) return;
    event.preventDefault();
    const current = items.indexOf(doc.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  doc.addEventListener('pointerdown', event => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  });
  doc.addEventListener('focusin', event => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== button) close();
  });
  return {sync, close};
}
