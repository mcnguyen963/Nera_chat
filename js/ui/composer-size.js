export function createComposerSizer({ input, frame = requestAnimationFrame }) {
  let queued = false, previousText, previousWidth, scrollToBottom = false;
  return ({ scroll = false } = {}) => {
    scrollToBottom ||= scroll;
    if (queued) return;
    queued = true;
    frame(() => {
      queued = false;
      const field = input(), text = field.value, width = field.clientWidth;
      if (text !== previousText || width !== previousWidth) {
        field.style.height = 'auto';
        field.style.height = field.scrollHeight + 'px';
        previousText = text; previousWidth = width;
      }
      if (scrollToBottom) field.scrollTop = field.scrollHeight;
      scrollToBottom = false;
    });
  };
}
