import { state } from "../state.js";
import { petAnimations, nextPetId, fits, clearPath, safeDestination, gestureAction, turnIsCurrent } from "./pet-behavior.js";

const PET_DIR = new URL("../../resources/pets/", import.meta.url);
const PET_FILE = /^[a-z0-9][a-z0-9._-]*\.(?:webp|png)$/i;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const MOBILE = window.matchMedia("(max-width: 720px)");
const sheets = new Map();
let root, sprite, layer, menu, slot, idleLabel;
let character = null, loaded = false, hiddenForVisit = false, pinned = false;
let activity = "idle", phase = "idle", frame = 0, frameAt = 0, raf = 0;
let reactionUntil = 0, nextTrip = 0, lastInput = Date.now(), lastTyping = 0, lastTap = 0;
let point = null, journey = null, pointer = null, holdTimer = 0, hiddenAt = 0;
let turn = null, turnSerial = 0, observedSession = null, loadSerial = 0;
let suspended = true, welcomeSession;
let layoutDirty = true, geometry = null;

function petFromFile(file) {
  if (!PET_FILE.test(file)) return null;
  const id = file === "violet.webp" ? "violet" : file;
  const name = file.replace(/\.(?:webp|png)$/i, "").replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return { id, name, image: new URL(encodeURIComponent(file), PET_DIR).href, animations: petAnimations(file) };
}
function selectedCharacters() {
  const ids = Array.isArray(state.settings?.petCharacterIds) ? state.settings.petCharacterIds : [];
  return [...new Set(ids)].map((id) => petFromFile(id === "violet" ? "violet.webp" : id)).filter(Boolean);
}
export async function loadPetCatalog() {
  const response = await fetch(new URL("manifest.json", PET_DIR), { cache: "no-cache" });
  if (!response.ok) throw new Error("Could not load the pet catalog.");
  const files = await response.json();
  if (!Array.isArray(files)) throw new Error("The pet catalog is invalid.");
  return files.filter((file) => typeof file === "string").map(petFromFile).filter(Boolean);
}
function loadSheet(pet) {
  if (sheets.has(pet.id)) return sheets.get(pet.id).promise;
  const image = new Image();
  const promise = new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => {
      if (sheets.get(pet.id)?.image === image) sheets.delete(pet.id);
      reject(new Error("Pet image unavailable."));
    };
  });
  sheets.set(pet.id, { image, promise });
  image.src = pet.image;
  return promise;
}
function chooseCharacter(pet) {
  character = pet;
  loaded = false;
  const serial = ++loadSerial;
  root.hidden = true;
  document.body.classList.remove("has-pet");
  void loadSheet(pet).then(() => {
    if (serial !== loadSerial || character?.id !== pet.id) return;
    loaded = true;
    document.body.style.setProperty("--pet-sheet", `url("${pet.image}")`);
    root.setAttribute("aria-label", `${pet.name} companion. Tap to play; hold for options or drag.`);
    setActivity(journey ? (journey.to.x < journey.from.x ? "left" : "right") : baseActivity());
    refreshPetPlacement();
    updateVisibility();
  }).catch(() => {
    if (serial !== loadSerial) return;
    loaded = false;
    root.hidden = true;
    document.body.classList.remove("has-pet");
    slot?.remove();
    stop();
  });
}

export function initPetView() {
  const old = document.getElementById("chat-pet");
  if (!old || root) return;
  old.remove();
  document.querySelector("#welcome .welcome-mark")?.removeAttribute("aria-hidden");
  layer = document.createElement("div");
  layer.className = "pet-layer";
  root = document.createElement("button");
  root.id = "chat-pet";
  root.type = "button";
  root.className = "chat-pet";
  root.hidden = true;
  root.setAttribute("aria-haspopup", "menu");
  sprite = document.createElement("span");
  sprite.className = "pet-sprite";
  sprite.setAttribute("aria-hidden", "true");
  root.append(sprite);
  menu = document.createElement("div");
  menu.id = "pet-menu";
  menu.className = "pet-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  root.setAttribute("aria-controls", menu.id);
  slot = document.createElement("span");
  slot.className = "pet-home-slot";
  slot.setAttribute("aria-hidden", "true");
  layer.append(root, menu);
  document.body.append(layer);
  root.addEventListener("pointerdown", beginPointer);
  root.addEventListener("touchmove", (event) => {
    if (pointer?.held || pointer?.dragging) event.preventDefault();
  }, { passive: false });
  root.addEventListener("click", (event) => { if (event.detail === 0) tap(); });
  window.addEventListener("pointermove", movePointer, { passive: false });
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", () => cancelPointer(true));
  root.addEventListener("contextmenu", (event) => { event.preventDefault(); cancelPointer(); openMenu(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); openMenu();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const buttons = [...menu.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    if (event.key === "Tab") closeMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !root.contains(event.target)) closeMenu();
  });
  document.addEventListener("settings-changed", syncPetSettings);
  document.addEventListener("settings-visibility-changed", updateVisibility);
  document.addEventListener("pet-restore", () => { hiddenForVisit = false; refreshPetPlacement(); updateVisibility(); });
  document.addEventListener("session-changed", (event) => {
    const id = event.detail?.sessionId ?? state.sessionId;
    if (id === observedSession) return;
    observedSession = id;
    turn = null; turnSerial++; phase = "idle"; pinned = false; point = null; journey = null;
    cancelPointer(); closeMenu(); reactionUntil = 0; lastInput = Date.now();
    setActivity("idle"); refreshPetPlacement();
  });
  document.getElementById("chat-input")?.addEventListener("input", () => {
    lastInput = Date.now();
    if (!state.busy && lastInput - lastTyping >= 5000) {
      lastTyping = lastInput; react("curious");
    } else if (!state.busy && activity === "sleep") setActivity("idle");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else {
      if (hiddenAt && Date.now() - hiddenAt >= 60000 && !state.busy) react("wave");
      hiddenAt = 0; nextTrip = Date.now() + 20000;
    }
    updateVisibility();
  });
  const invalidate = () => {
    layoutDirty = true;
    if (point) floatingSize();
    if (REDUCED_MOTION.matches) placeHome();
    if (!raf) updateVisibility();
  };
  window.addEventListener("resize", invalidate);
  document.addEventListener("scroll", invalidate, { capture: true, passive: true });
  window.visualViewport?.addEventListener("resize", invalidate);
  window.visualViewport?.addEventListener("scroll", invalidate);
  REDUCED_MOTION.addEventListener?.("change", () => {
    cancelPointer(true); journey = null; point = null; pinned = false;
    refreshPetPlacement(); updateVisibility();
  });
  observedSession = state.sessionId;
  const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
    const blocked = isSuspended();
    if (blocked !== suspended) updateVisibility();
    layoutDirty = true;
  });
  observer?.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  observer?.observe(document.getElementById("chat-tab"), { attributes: true, attributeFilter: ["class", "hidden"] });
  const app = document.getElementById("app");
  if (app) observer?.observe(app, { attributes: true, attributeFilter: ["class", "hidden"] });
  document.querySelectorAll("#top-menu, #composer-popover").forEach((node) =>
    observer?.observe(node, { attributes: true, attributeFilter: ["hidden"] }));
  syncPetSettings();
}

export function invalidatePetLayout() { layoutDirty = true; }

export function startPetTurn() {
  const selected = selectedCharacters();
  turn = { id: ++turnSerial, sessionId: state.sessionId };
  phase = "thinking"; lastInput = Date.now(); reactionUntil = 0;
  if (!root || !selected.length) return turn;
  const id = nextPetId(selected.map((pet) => pet.id), character?.id);
  const next = selected.find((pet) => pet.id === id);
  if (next.id !== character?.id) chooseCharacter(next);
  refreshPetPlacement();
  if (!journey) setActivity(baseActivity());
  return turn;
}
export function updatePetPhase(next, token = turn) {
  if (!turnIsCurrent(token, turn, state.sessionId)) return;
  phase = next; lastInput = Date.now();
  layoutDirty = true;
  if (!journey && Date.now() >= reactionUntil) setActivity(baseActivity());
}
export function finishPetTurn(status = "ready", token = turn) {
  if (!turnIsCurrent(token, turn, state.sessionId)) return;
  turn = null;
  phase = "idle"; lastInput = Date.now();
  journey = null;
  react(status === "ready" ? "jump" : status === "cancelled" ? "idle" : "curious");
}
function baseActivity() {
  if (["writing", "generating"].includes(phase)) return "writing";
  if (phase !== "idle" || state.busy) return "thinking";
  return "idle";
}
function setActivity(next) {
  if (!root || !character) return;
  if (activity === next) return;
  activity = next; frame = 0; frameAt = 0;
  root.dataset.activity = activity;
  drawFrame(); start();
}
function react(next) {
  if (!loaded || hiddenForVisit || isSuspended()) return;
  journey = null; frame = 0; frameAt = 0;
  layoutDirty = true;
  const animation = character.animations[next] ?? character.animations.idle;
  reactionUntil = Date.now() + animation.frames / animation.fps * 1000;
  setActivity(next);
  drawFrame();
}
function tap() {
  if (Date.now() - lastTap < 1000) return;
  lastTap = lastInput = Date.now();
  closeMenu();
  const choices = character?.id === "lilith.webp" ? ["wave", "jump"] : ["wave", "jump", "writing"];
  react(choices[Math.floor(Math.random() * choices.length)]);
}

export function refreshPetPlacement() {
  if (!root || !character) return;
  const previousPosition = root.getBoundingClientRect();
  const welcome = document.getElementById("welcome");
  let target = !welcome?.hidden ? welcome?.querySelector(".welcome-mark") : null;
  const atWelcome = !!target;
  if (!target) {
    const labels = document.querySelectorAll("#message-list .msg.assistant .msg-meta > span:first-child");
    target = labels[labels.length - 1];
  }
  if (!target) {
    if (!idleLabel) {
      idleLabel = document.createElement("div"); idleLabel.className = "pet-idle-label msg-meta";
      const label = document.createElement("span"); label.textContent = "Assistant"; idleLabel.append(label);
    }
    document.getElementById("message-list")?.append(idleLabel); target = idleLabel.firstElementChild;
  } else if (target !== idleLabel?.firstElementChild) idleLabel?.remove();
  const wasWelcome = slot.classList.contains("pet-welcome-slot");
  slot.parentElement?.classList.remove("pet-host");
  slot.classList.toggle("pet-welcome-slot", atWelcome);
  if (slot.parentNode !== target) target.prepend(slot);
  target.classList.add("pet-host");
  layoutDirty = true;
  if (loaded && atWelcome && welcomeSession !== state.sessionId) {
    welcomeSession = state.sessionId; point = null; journey = null;
    if (loaded) react("wave");
  }
  if (wasWelcome && !atWelcome) {
    point = null; journey = null; nextTrip = Date.now() + 20000;
    if (loaded && !REDUCED_MOTION.matches && state.settings?.petMovement !== "stay") {
      measureGeometry();
      const home = homePoint();
      const size = floatingBox();
      const from = { x: previousPosition.left + previousPosition.width / 2 - size / 2,
        y: previousPosition.top + previousPosition.height / 2 - size / 2 };
      const to = home && { x: home.x + (64 - size) / 2, y: home.y + (64 - size) / 2 };
      const distance = to && Math.hypot(to.x - from.x, to.y - from.y);
      if (to && distance > 8 && distance <= (MOBILE.matches ? 90 : 120) * 3 &&
          clearPath(from, to, geometry.bounds, size, geometry.controls)) {
        point = from; floatingSize(); paintPosition(point);
        journey = { from, to, at: performance.now(), duration: distance / (MOBILE.matches ? 90 : 120) * 1000, home: true };
        setActivity(to.x < from.x ? "left" : "right");
      }
    }
  }
  if (!point || state.settings?.petMovement === "stay" || REDUCED_MOTION.matches) placeHome();
  updateVisibility();
}
function homePoint() {
  const rect = slot?.getBoundingClientRect();
  if (!rect || !rect.width) return null;
  return { x: rect.left, y: rect.top };
}
function placeHome() {
  point = null; journey = null;
  const home = homePoint();
  const welcome = slot?.classList.contains("pet-welcome-slot");
  root?.style.setProperty("--pet-box", `${welcome ? (MOBILE.matches ? 156 : 208) : 64}px`);
  root?.style.setProperty("--pet-size", `${welcome ? (MOBILE.matches ? 144 : 192) : 56}px`);
  if (home) paintPosition(home);
}
function floatingBox() { return MOBILE.matches ? 70 : 88; }
function floatingSize() {
  root.style.setProperty("--pet-box", `${floatingBox()}px`);
  root.style.setProperty("--pet-size", `${MOBILE.matches ? 64 : 80}px`);
}
function paintPosition(position) {
  root.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
}
function isSuspended() {
  return document.hidden || document.body.classList.contains("settings-open") ||
    document.body.classList.contains("sidebar-open") || document.getElementById("app")?.classList.contains("hidden") ||
    document.getElementById("chat-tab")?.classList.contains("hidden") ||
    document.getElementById("top-menu")?.hidden === false || document.getElementById("composer-popover")?.hidden === false;
}
function updateVisibility() {
  if (!root) return;
  suspended = isSuspended();
  const enabled = loaded && !!character && !hiddenForVisit;
  document.body.classList.toggle("has-pet", enabled);
  slot.hidden = !enabled;
  if (!enabled) {
    root.hidden = true; closeMenu(); stop(); cancelPointer(); journey = null;
    return;
  }
  const rect = slot.getBoundingClientRect();
  const list = document.getElementById("message-list")?.getBoundingClientRect();
  const homeVisible = rect.width && rect.top >= (list?.top ?? 0) && rect.bottom <= (list?.bottom ?? window.innerHeight);
  root.hidden = !enabled || suspended || (!point && !slot.classList.contains("pet-welcome-slot") && !homeVisible);
  if (root.hidden) { closeMenu(); stop(); if (!pointer?.scrolling) cancelPointer(); journey = null; }
  else { if (!point) placeHome(); drawFrame(); start(); }
}
function syncPetSettings() {
  if (!root) return;
  const selected = selectedCharacters();
  for (const id of sheets.keys()) if (!selected.some((pet) => pet.id === id)) sheets.delete(id);
  if (selected.length > 1) selected.forEach((pet) => { void loadSheet(pet).catch(() => {}); });
  if (!selected.length) {
    loadSerial++; turnSerial++; turn = null; character = null; loaded = false; phase = "idle";
    pinned = false; point = null; journey = null; hiddenForVisit = false;
    stop(); cancelPointer(); closeMenu(); slot.parentElement?.classList.remove("pet-host");
    slot.remove(); idleLabel?.remove(); root.hidden = true;
    document.body.classList.remove("has-pet"); document.body.style.removeProperty("--pet-sheet");
    return;
  }
  if (!character || !selected.some((pet) => pet.id === character.id) || !loaded) chooseCharacter(selected[0]);
  if (state.settings?.petMovement === "stay") { pinned = false; placeHome(); }
  nextTrip = Date.now() + 20000;
  refreshPetPlacement();
}

function rectBox(rect) { return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; }
function measureGeometry() {
  const viewport = window.visualViewport;
  const inset = window.getComputedStyle?.(layer);
  const safeTop = Number.parseFloat(inset?.paddingTop) || 0;
  const safeLeft = Number.parseFloat(inset?.paddingLeft) || 0;
  const safeRight = Number.parseFloat(inset?.paddingRight) || 0;
  const main = document.querySelector(".main")?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth, top: 0 };
  const composer = document.getElementById("composer")?.getBoundingClientRect();
  const left = Math.max(main.left + 8, (viewport?.offsetLeft ?? 0) + safeLeft + 8);
  const top = Math.max(main.top + 8, (viewport?.offsetTop ?? 0) + safeTop + 8);
  const right = Math.min(main.right - 8, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - safeRight - 8);
  const bottom = Math.min(composer?.top ?? window.innerHeight, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)) - 8;
  const bounds = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  const collect = (selector) => [...document.querySelectorAll(selector)]
    .filter((node) => !layer.contains(node) && !node.closest("[hidden], .hidden") && node.getClientRects().length)
    .map((node) => rectBox(node.getBoundingClientRect()));
  const controls = collect(".main button, .main input, .main select, .main textarea, .main a, .main summary, #top-menu:not([hidden]), #composer-popover:not([hidden]), .top-bar-title, .context-indicator");
  const text = collect(".msg-content, .msg-meta, .thinking, .msg-editor, .welcome h1, .welcome p, .msg.summary, .msg.error");
  const candidates = [];
  for (let y = top; y + floatingBox() <= bottom; y += 24) for (let x = left; x + floatingBox() <= right; x += 24) candidates.push({ x, y });
  geometry = { bounds, controls, text, candidates }; layoutDirty = false;
}
function safeRest(position) {
  if (layoutDirty || !geometry) measureGeometry();
  return safeDestination(position, geometry.candidates, geometry.bounds, floatingBox(), [...geometry.controls, ...geometry.text]);
}
function explore(now) {
  nextTrip = now + 20000 + Math.random() * 20000;
  if (pinned || REDUCED_MOTION.matches || state.settings?.petMovement === "stay" || activity === "sleep" || !menu.hidden || pointer) return;
  if (layoutDirty || !geometry) measureGeometry();
  const from = point ?? homePoint();
  if (!from) return;
  const speed = MOBILE.matches ? 90 : 120;
  const candidates = geometry.candidates.filter((candidate) => {
    const distance = Math.hypot(candidate.x - from.x, candidate.y - from.y);
    return distance > 48 && distance <= speed * 3 &&
      fits(candidate, geometry.bounds, floatingBox(), [...geometry.controls, ...geometry.text]) &&
      clearPath(from, candidate, geometry.bounds, floatingBox(), geometry.controls);
  });
  if (!candidates.length) return;
  const to = candidates[Math.floor(Math.random() * candidates.length)];
  point = { ...from }; floatingSize();
  journey = { from, to, at: performance.now(), duration: Math.hypot(to.x - from.x, to.y - from.y) / speed * 1000 };
  setActivity(to.x < from.x ? "left" : "right");
}
function validatePosition() {
  measureGeometry();
  if (!point || pointer?.dragging) return;
  if (journey && !clearPath(point, journey.to, geometry.bounds, floatingBox(), geometry.controls)) journey = null;
  if (!fits(point, geometry.bounds, floatingBox(), geometry.controls) || (!journey && !fits(point, geometry.bounds, floatingBox(), geometry.text))) {
    const safe = safeRest(point);
    if (safe) { point = safe; paintPosition(point); }
    else { pinned = false; placeHome(); }
    journey = null;
  }
}
function drawFrame() {
  if (!loaded || root.hidden) return;
  const animation = character.animations[activity] ?? character.animations.idle;
  const width = Number.parseFloat(root.style.getPropertyValue("--pet-size")) || 56;
  const height = width * 208 / 192;
  const col = REDUCED_MOTION.matches ? 0 : frame % animation.frames;
  sprite.style.backgroundPosition = `${-col * width}px ${-animation.row * height}px`;
}
function stop() { cancelAnimationFrame(raf); raf = 0; frameAt = 0; }
function start() {
  if (!raf && loaded && !root.hidden && !REDUCED_MOTION.matches) raf = requestAnimationFrame(tick);
}
function tick(now) {
  raf = 0;
  if (!loaded || root.hidden || isSuspended() || REDUCED_MOTION.matches) return;
  const clock = Date.now();
  if (layoutDirty) { validatePosition(); updateVisibility(); if (root.hidden) return; }
  if (!point) placeHome();
  if (journey) {
    const t = Math.min(1, (now - journey.at) / journey.duration);
    point = { x: journey.from.x + (journey.to.x - journey.from.x) * t, y: journey.from.y + (journey.to.y - journey.from.y) * t };
    paintPosition(point);
    if (t === 1) {
      const home = journey.home;
      journey = null;
      if (home) placeHome();
      setActivity(baseActivity());
    }
  } else if (!pointer?.dragging && menu.hidden) {
    if (clock >= reactionUntil) {
      if (phase === "idle" && !state.busy && clock - lastInput >= 60000) {
        if (activity !== "yawn" && activity !== "sleep") react("yawn");
        else if (activity === "yawn") setActivity("sleep");
      } else {
        const base = baseActivity();
        // Violet alternates her friendly gesture with quiet idle while writing.
        setActivity(character.id === "violet" && base === "writing" && Math.floor(clock / 3000) % 2 ? "idle" : base);
      }
    }
    if (clock >= nextTrip && clock >= reactionUntil) explore(clock);
  }
  const animation = character.animations[activity] ?? character.animations.idle;
  if (!frameAt) frameAt = now;
  if (now - frameAt >= 1000 / animation.fps) { frame++; frameAt = now; drawFrame(); }
  if (!raf) start();
}

function beginPointer(event) {
  if (event.button !== 0 || pointer) return;
  closeMenu(); journey = null;
  pointer = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY,
    lastY: event.clientY, at: Date.now(), origin: point ?? homePoint(), dragging: false, held: false, scrolling: false };
  if (event.pointerType !== "mouse") {
    holdTimer = window.setTimeout(() => {
      if (!pointer) return;
      pointer.held = true;
      root.classList.add("pet-drag-ready");
      root.setPointerCapture?.(pointer.id);
    }, 350);
  }
}
function movePointer(event) {
  if (!pointer || event.pointerId !== pointer.id) return;
  const action = gestureAction(pointer, event.clientX, event.clientY, Date.now());
  if (action === "scroll" || pointer.scrolling) {
    // A fixed overlay has no scrolling ancestor. Forward early finger movement
    // to the conversation so starting a swipe on the pet still scrolls messages.
    pointer.scrolling = true;
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = 0;
    const list = document.getElementById("message-list");
    if (list) list.scrollTop = Math.max(0, (list.scrollTop || 0) + pointer.lastY - event.clientY);
    pointer.lastY = event.clientY;
    event.preventDefault(); layoutDirty = true;
    return;
  }
  if (action !== "drag" && !pointer.dragging) return;
  if (REDUCED_MOTION.matches || state.settings?.petMovement === "stay") {
    cancelPointer(); return;
  }
  event.preventDefault();
  pointer.dragging = true; window.clearTimeout(holdTimer);
  root.setPointerCapture?.(pointer.id); floatingSize();
  if (!pointer.origin) return;
  if (layoutDirty || !geometry) measureGeometry();
  const bounds = geometry.bounds;
  point = {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - floatingBox(), pointer.origin.x + event.clientX - pointer.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - floatingBox(), pointer.origin.y + event.clientY - pointer.y)),
  };
  paintPosition(point); setActivity(event.clientX < pointer.x ? "left" : "right");
}
function endPointer(event) {
  if (!pointer || event.pointerId !== pointer.id) return;
  const dragging = pointer.dragging, held = pointer.held, scrolling = pointer.scrolling;
  cancelPointer(); lastInput = Date.now();
  if (scrolling) return;
  if (dragging) {
    const safe = safeRest(point);
    if (safe) { point = safe; paintPosition(point); } else placeHome();
    pinned = false; nextTrip = Date.now() + 10000; react("jump");
  } else if (held) openMenu();
  else tap();
}
function cancelPointer(snap = false) {
  if (holdTimer) window.clearTimeout(holdTimer);
  holdTimer = 0;
  if (pointer && root.hasPointerCapture?.(pointer.id)) root.releasePointerCapture(pointer.id);
  const wasDragging = pointer?.dragging;
  pointer = null; root?.classList.remove("pet-drag-ready");
  if (snap && wasDragging && loaded) {
    const safe = safeRest(point);
    if (safe) { point = safe; paintPosition(point); } else placeHome();
  }
}
function closeMenu(focus = false) {
  if (!menu) return;
  menu.hidden = true; root.setAttribute("aria-expanded", "false");
  if (focus && !root.hidden) root.focus({ preventScroll: true });
}
function openMenu() {
  if (!loaded || root.hidden) return;
  journey = null;
  if (point) { const safe = safeRest(point); if (safe) { point = safe; paintPosition(point); } else placeHome(); }
  const button = (label, action) => {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    node.setAttribute("role", "menuitem");
    node.addEventListener("click", () => { closeMenu(true); action(); }); return node;
  };
  menu.replaceChildren(
    button("Change pet", () => document.dispatchEvent(new CustomEvent("pet-settings-open", { detail: { trigger: root } }))),
    button(pinned ? "Resume exploring" : "Stay here", () => {
      pinned = !pinned; nextTrip = Date.now() + 10000;
    }),
    button("Return to Assistant", () => { pinned = false; placeHome(); nextTrip = Date.now() + 10000; updateVisibility(); }),
    button("Hide for this visit", () => { hiddenForVisit = true; updateVisibility(); })
  );
  menu.hidden = false; root.setAttribute("aria-expanded", "true");
  const rect = root.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const vv = window.visualViewport;
  const left = vv?.offsetLeft ?? 0, top = vv?.offsetTop ?? 0;
  const right = left + (vv?.width ?? window.innerWidth), bottom = top + (vv?.height ?? window.innerHeight);
  menu.style.left = `${Math.max(left + 8, Math.min(rect.left, right - width - 8))}px`;
  menu.style.top = `${Math.max(top + 8, Math.min(rect.bottom + 6, bottom - height - 8))}px`;
  menu.querySelector("button")?.focus({ preventScroll: true });
}
