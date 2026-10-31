export function createComposerSizer({ input, frame = requestAnimationFrame }) {
  let queued = false, previousText, previousWidth, previousHeight, scrollToBottom = false;
  return ({ scroll = false } = {}) => {
    scrollToBottom ||= scroll;
    if (queued) return;
    queued = true;
    frame(() => {
      queued = false;
      const field = input(), text = field.value, width = field.clientWidth;
      const height = globalThis.window?.visualViewport?.height ?? globalThis.window?.innerHeight;
      if (text !== previousText || width !== previousWidth || height !== previousHeight) {
        field.style.height = 'auto';
        field.style.height = field.scrollHeight + 'px';
        previousText = text; previousWidth = width; previousHeight = height;
      }
      if (scrollToBottom) field.scrollTop = field.scrollHeight;
      scrollToBottom = false;
    });
  };
}

// The transparent composer floats over the story. Reserve its current height
// in the list's scrollable padding so the final message can clear the controls.
export function observeComposerInset({shell, style, onResize, frame = requestAnimationFrame, Observer = globalThis.ResizeObserver}) {
  let queued = false, previousHeight;
  const schedule = () => {
    if (queued) return;
    queued = true;
    frame(() => {
      queued = false;
      const height = Math.ceil(shell.getBoundingClientRect().height);
      if (height <= 0 || height === previousHeight) return;
      previousHeight = height;
      style.setProperty?.('--composer-height', height + 'px');
      const input = shell.querySelector?.('.composer-input');
      if (input) style.setProperty?.('--composer-chrome-height', Math.max(0, height - input.getBoundingClientRect().height) + 'px');
      onResize();
    });
  };
  const observing = typeof Observer === 'function';
  if (observing) new Observer(schedule).observe(shell);
  schedule();
  // Modern browsers report actual height changes; avoid an extra layout read
  // on every keystroke. The returned scheduler is only the legacy fallback.
  return observing ? () => {} : schedule;
}
