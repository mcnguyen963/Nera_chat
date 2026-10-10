// One running computation and one replacement. Focused calls settle immediately.
export function createIndicatorRefresh({ focused, key, compute, apply, onError, schedule = fn => setTimeout(fn, 0), cancel = clearTimeout }) {
  let revision = 0, pending = false, running = null, timer = null;
  function queue() {
    if (!pending || focused() || running || timer !== null) return;
    timer = schedule(() => { timer = null; void drain(); });
  }
  async function drain() {
    if (running) return running;
    if (focused() || !pending) return;
    pending = false;
    const version = revision, source = key();
    const valid = () => version === revision && source === key() && !focused();
    running = (async () => {
      try { const result = await compute(); if (valid()) apply(result); }
      catch (error) { if (valid()) onError(error); }
    })();
    await running;
    running = null;
    if (source !== key()) pending = true;
    if (pending && !focused()) await drain();
  }
  return {
    async request() {
      revision++; pending = true;
      if (focused()) return;
      if (timer !== null) { cancel(timer); timer = null; }
      if (running) { await running; return drain(); }
      return drain();
    },
    invalidate() { revision++; pending = true; if (timer !== null) { cancel(timer); timer = null; } },
    blur() { revision++; pending = true; queue(); },
  };
}
