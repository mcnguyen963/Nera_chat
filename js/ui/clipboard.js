export async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } } catch {}
  const active = document.activeElement;
  const selection = document.getSelection?.();
  const ranges = selection ? Array.from({length:selection.rangeCount}, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const fieldSelection = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const scroll = new Map();
  const rememberScroll = node => { if (node && !scroll.has(node)) scroll.set(node, [node.scrollLeft, node.scrollTop]); };
  for (let node = active; node; node = node.parentElement) rememberScroll(node);
  for (let node = selection?.anchorNode?.parentElement; node; node = node.parentElement) rememberScroll(node);
  document.querySelectorAll?.('.message-list, .settings-content, .memory-content, .lore-list, .lore-editor').forEach(rememberScroll);
  const x = window.scrollX, y = window.scrollY;
  const ta = document.createElement('textarea');
  ta.value = text; ta.readOnly = true; ta.contentEditable = true;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  ta.setAttribute('aria-label', 'Clipboard transfer');
  document.body.appendChild(ta);
  try {
    ta.focus({preventScroll:true}); ta.select(); ta.setSelectionRange(0, ta.value.length);
    if (!document.execCommand('copy')) throw new Error('Could not copy. Select and copy the text manually.');
  } finally {
    ta.remove();
    active?.focus?.({preventScroll:true});
    if (fieldSelection) active.setSelectionRange(...fieldSelection);
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
    for (const [node, [left, top]] of scroll) { node.scrollLeft = left; node.scrollTop = top; }
    if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
  }
}
