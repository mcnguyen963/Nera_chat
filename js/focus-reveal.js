// Compute the smallest movement that reveals a field/caret in its own scroller.
export function revealDelta(target, visible, margin = 8) {
  const top = visible.top + margin, bottom = visible.bottom - margin;
  if (bottom <= top) return 0;
  if (target.bottom > bottom) return target.bottom - bottom;
  if (target.top < top) return target.top - top;
  return 0;
}
const editable = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), [contenteditable=true]';
function caretRect(field, rect, style) {
  if (field.tagName !== 'TEXTAREA') return rect;
  // A temporary mirror measures wrapping without changing selection or focus.
  const mirror = document.createElement('div'), marker = document.createElement('span');
  for (const name of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textIndent','paddingTop','paddingRight','paddingBottom','paddingLeft','boxSizing','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','tabSize']) mirror.style[name] = style[name];
  Object.assign(mirror.style, {position:'fixed', visibility:'hidden', pointerEvents:'none', whiteSpace:'pre-wrap', overflowWrap:'break-word', width:field.offsetWidth+'px', borderStyle:'solid', top:'0', left:'0'});
  mirror.textContent = field.value.slice(0, field.selectionEnd ?? field.value.length);
  marker.textContent = '\u200b'; mirror.append(marker); document.body.append(mirror);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  const y = marker.offsetTop;
  if (y < field.scrollTop) field.scrollTop = y;
  else if (y + line > field.scrollTop + field.clientHeight) field.scrollTop = y + line - field.clientHeight;
  const scale = rect.width / (field.offsetWidth || rect.width);
  const top = rect.top + (y - field.scrollTop) * scale;
  mirror.remove();
  return {top, bottom:top + line * scale, left:rect.left, right:rect.right};
}
export function revealFocusedField(field = document.activeElement) {
  const vv = window.visualViewport;
  if (!field?.matches?.(editable) || !field.isConnected || field.closest('[hidden],.hidden') || vv && Math.abs(vv.scale - 1) >= .01) return;
  const fieldStyle = getComputedStyle(field);
  let target = caretRect(field, field.getBoundingClientRect(), fieldStyle);
  const bounds = {top:Math.max(0, vv?.offsetTop || 0), bottom:(vv?.offsetTop || 0) + (vv?.height || window.innerHeight)};
  // Fixed overlays which share the chat scroller's space are not its ancestors.
  if (field.closest('.message-list')) {
    const scope = field.closest('.chat-tab') || document;
    for (const selector of ['.top-bar', '.composer']) {
      const node = scope.querySelector(selector) || document.querySelector(selector);
      if (!node || !node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      if (selector === '.top-bar') bounds.top = Math.max(bounds.top, r.bottom);
      else bounds.bottom = Math.min(bounds.bottom, r.top);
    }
  }
  for (let parent = field.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/(auto|scroll|hidden|clip)/.test(style.overflowY)) continue;
    const rect = parent.getBoundingClientRect();
    const visible = {top:Math.max(bounds.top, rect.top), bottom:Math.min(bounds.bottom, rect.bottom)};
    for (const action of parent.querySelectorAll('.memory-actions, .msg-actions')) {
      if (action.contains(field) || !action.getClientRects().length || getComputedStyle(action).position !== 'sticky') continue;
      const r = action.getBoundingClientRect();
      if (r.top > visible.top && r.top < visible.bottom) visible.bottom = r.top;
    }
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
      const before = parent.scrollTop;
      parent.scrollTop += revealDelta(target, visible);
      const moved = parent.scrollTop - before;
      target = {...target, top:target.top - moved, bottom:target.bottom - moved};
    }
    bounds.top = visible.top; bounds.bottom = visible.bottom;
  }
}
