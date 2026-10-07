export function viewportVars(viewport) {
  if (!viewport || Math.abs(viewport.scale - 1) >= 0.01 ||
      !Number.isFinite(viewport.height) || viewport.height <= 0) return null;
  return { height: viewport.height + "px", offsetTop: Math.max(0, viewport.offsetTop || 0) + "px" };
}

export function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const style = document.documentElement.style;
  const sync = () => {
    const vars = viewportVars(vv);
    style.setProperty("--app-offset-top", vars && ios ? vars.offsetTop : "0px");
    style.setProperty("--app-viewport-transform", vars && ios ? `translateY(${vars.offsetTop})` : "none");
    if (!vars) return; // Pinch zoom must not shrink the layout.
    style.setProperty("--app-height", vars.height);
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("pageshow", sync);
  let settleTimer;
  document.addEventListener("focusout", () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => requestAnimationFrame(sync), 350);
  });
  sync();
}
