export function viewportVars(viewport) {
  if (!viewport || Math.abs(viewport.scale - 1) >= 0.01 ||
      !Number.isFinite(viewport.height) || viewport.height <= 0) return null;
  return { height: viewport.height + "px", offsetTop: Math.max(0, viewport.offsetTop || 0) + "px" };
}

// A focused field alone does not imply a software keyboard (hardware keyboards
// and browser toolbar resizes must retain the device's bottom safe area).
export function keyboardVisible({height, layoutHeight, baselineHeight, focused, wasOpen = false}) {
  const loss = Math.max(layoutHeight || 0, baselineHeight || 0) - height;
  return (focused || wasOpen) && loss > 140;
}

export function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const style = document.documentElement.style;
  let baseline = vv.height, width = window.innerWidth, keyboard = false, queued = false;
  const applied=new Map();
  const write=(key,value)=>{if(applied.get(key)!==value){style.setProperty(key,value);applied.set(key,value);}};
  const sync = () => {
    queued = false;
    const vars = viewportVars(vv);
    if (!vars) return; // Pinch zoom must not shrink or reposition the layout.
    if (Math.abs(window.innerWidth - width) > 80) {
      width = window.innerWidth;
      baseline = Math.max(window.innerHeight, document.documentElement.clientHeight);
    }
    const focused = !!document.activeElement?.matches?.('textarea, input:not([type=checkbox]):not([type=radio]), [contenteditable=true]');
    keyboard = keyboardVisible({height:vv.height, layoutHeight:window.innerHeight, baselineHeight:baseline, focused, wasOpen:keyboard});
    if (!keyboard) baseline = vv.height;
    write("--app-offset-top", ios ? vars.offsetTop : "0px");
    write("--app-viewport-transform", ios ? `translateY(${vars.offsetTop})` : "none");
    write("--app-height", vars.height);
    write("--composer-safe-bottom", keyboard ? "0px" : "var(--safe-bottom)");
    const keyboardState=keyboard ? 'open' : 'closed';
    if(document.documentElement.dataset.keyboard!==keyboardState)document.documentElement.dataset.keyboard=keyboardState;
    // Only undo keyboard focus panning, never normal browser toolbar scrolling.
    if (keyboard && ios && (window.scrollX !== 0 || window.scrollY !== 0)) window.scrollTo(0, 0);
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(sync); } };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("pageshow", schedule);
  document.addEventListener('focusin', schedule);
  let settleTimer;
  document.addEventListener("focusout", () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(schedule, 350);
  });
  sync();
}
