// Request-local pulses: no perpetual timer and no replay of hidden-page events.
export function createStreamVibration(mode, {
  navigator: nav = globalThis.navigator,
  document: doc = globalThis.document,
  now = () => Date.now(),
  schedule = (fn, delay) => setTimeout(fn, delay),
  cancel = (id) => clearTimeout(id),
} = {}) {
  let stopped = false, timer = null, lastPulse = -Infinity, lastArrival = null;
  let pendingDuration = 0, rate = 0;
  const enabled = ["speed", "spaces"].includes(mode) && typeof nav?.vibrate === "function";
  const vibrate = (duration) => { try { nav.vibrate(duration); } catch { /* Unsupported or blocked hardware. */ } };
  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    pendingDuration = 0;
  };
  const hide = () => {
    if (!doc?.hidden) return;
    clear(); lastArrival = null; rate = 0;
    if (enabled) vibrate(0);
  };
  const pulse = () => {
    timer = null;
    if (stopped || doc?.hidden) { pendingDuration = 0; return; }
    lastPulse = now();
    vibrate(pendingDuration);
    pendingDuration = 0;
  };
  if (enabled) doc?.addEventListener("visibilitychange", hide);
  return {
    feed(text) {
      if (!enabled || stopped || doc?.hidden || !text) return;
      const time = now();
      if (mode === "spaces") {
        if (!text.includes(" ")) return;
        pendingDuration = 10;
      } else {
        const elapsed = lastArrival === null ? 100 : Math.max(1, time - lastArrival);
        const currentRate = text.length * 1000 / elapsed;
        rate = lastArrival === null || elapsed > 1000 ? currentRate : rate * 0.7 + currentRate * 0.3;
        lastArrival = time;
        pendingDuration = Math.round(8 + Math.min(1, rate / 200) * 17);
      }
      if (timer !== null) return;
      const delay = Math.max(0, (mode === "spaces" ? 80 : 60) - (time - lastPulse));
      if (delay === 0) pulse();
      else timer = schedule(pulse, delay);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clear();
      if (enabled) { vibrate(0); doc?.removeEventListener("visibilitychange", hide); }
    },
  };
}
