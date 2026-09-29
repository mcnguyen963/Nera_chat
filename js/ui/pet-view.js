import { state } from "../state.js";

// Add future built-in companions here. Each sheet uses an 8-column by 9-row
// grid of 192 × 208 cells; rows are zero-based in the animation definitions.
export const PET_CATALOG = [
  {
    id: "violet",
    name: "Violet",
    image: new URL("../../resources/violet.webp", import.meta.url).href,
    idle: { row: 0, frames: 6, fps: 5 },
    running: { row: 1, frames: 8, fps: 10 },
    ready: { row: 4, frames: 5, fps: 8 },
    blocked: { row: 3, frames: 4, fps: 6 },
  },
];

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
let root;
let character = null;
let activity = "idle";
let frame = 0;
let lastTick = 0;
let raf = 0;
let generation = 0;
let idleLabel = null;

export function initPetView() {
  root = document.getElementById("chat-pet");
  if (!root) return;
  document.addEventListener("settings-changed", syncPetSettings);
  REDUCED_MOTION.addEventListener?.("change", () => {
    cancelAnimationFrame(raf);
    raf = 0;
    drawFrame();
    if (!REDUCED_MOTION.matches && character && !root.hidden) raf = requestAnimationFrame(tick);
  });
  syncPetSettings();
}

export function startPetTurn() {
  const selected = selectedCharacters();
  if (!selected.length) return;
  const next = selected[Math.floor(Math.random() * selected.length)];
  if (next !== character) {
    character = next;
    document.body.style.setProperty("--pet-sheet", `url("${character.image}")`);
  }
  root.hidden = false;
  document.body.classList.add("has-pet");
  refreshPetPlacement();
  setActivity("running");
}

export function refreshPetPlacement() {
  if (!root) return;
  const welcomeMark = document.querySelector("#welcome .welcome-mark");
  if (!character) {
    root.parentElement?.classList.remove("pet-host");
    if (welcomeMark && root.parentNode !== welcomeMark) welcomeMark.appendChild(root);
    idleLabel?.remove();
    return;
  }
  const labels = document.querySelectorAll("#message-list .msg.assistant .msg-meta > span:first-child");
  let target = labels[labels.length - 1];
  if (!target && !document.getElementById("welcome")?.hidden) target = welcomeMark;
  if (!target) {
    if (!idleLabel) {
      idleLabel = document.createElement("div");
      idleLabel.className = "pet-idle-label msg-meta";
      const label = document.createElement("span");
      label.textContent = "Assistant";
      idleLabel.appendChild(label);
    }
    document.getElementById("message-list")?.appendChild(idleLabel);
    target = idleLabel.firstElementChild;
  } else {
    idleLabel?.remove();
  }
  if (target) {
    root.parentElement?.classList.remove("pet-host");
    if (root.parentNode !== target) target.prepend(root);
    target.classList.add("pet-host");
  }
}

export function finishPetTurn(status = "ready") {
  if (!character || root.hidden) return;
  setActivity(status);
  const run = generation;
  window.setTimeout(() => {
    if (generation === run && activity === status) setActivity("idle");
  }, REDUCED_MOTION.matches ? 900 : character[status].frames / character[status].fps * 1000);
}

function selectedCharacters() {
  const ids = Array.isArray(state.settings?.petCharacterIds) ? state.settings.petCharacterIds : [];
  return PET_CATALOG.filter((pet) => ids.includes(pet.id));
}

function syncPetSettings() {
  const selected = selectedCharacters();
  if (!selected.length) {
    generation++;
    cancelAnimationFrame(raf);
    raf = 0;
    character = null;
    root.hidden = true;
    document.body.classList.remove("has-pet");
    document.body.style.removeProperty("--pet-sheet");
    refreshPetPlacement();
    return;
  }
  if (!character || !selected.some((pet) => pet.id === character.id)) {
    character = selected[0];
    document.body.style.setProperty("--pet-sheet", `url("${character.image}")`);
  }
  root.hidden = false;
  document.body.classList.add("has-pet");
  refreshPetPlacement();
  setActivity(state.busy ? "running" : "idle");
}

function setActivity(next) {
  activity = next;
  frame = 0;
  lastTick = 0;
  generation++;
  root.dataset.activity = next;
  cancelAnimationFrame(raf);
  raf = 0;
  drawFrame();
  if (!REDUCED_MOTION.matches) raf = requestAnimationFrame(tick);
}

function drawFrame() {
  if (!root || root.hidden || !character) return;
  const animation = character[activity] ?? character.idle;
  const col = REDUCED_MOTION.matches ? 0 : frame % animation.frames;
  root.style.backgroundPosition = `${col / 7 * 100}% ${animation.row / 8 * 100}%`;
}

function tick(now) {
  if (root.hidden || !character || REDUCED_MOTION.matches) { raf = 0; return; }
  const animation = character[activity] ?? character.idle;
  if (!lastTick) lastTick = now;
  else if (now - lastTick >= 1000 / animation.fps) {
    frame++;
    lastTick = now;
    drawFrame();
  }
  raf = requestAnimationFrame(tick);
}
