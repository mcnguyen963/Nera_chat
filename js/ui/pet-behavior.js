// Pure sprite, gesture, and geometry helpers shared by the pet view and tests.
const animation = (row, frames = 6, fps = 6) => ({ row, frames, fps });
export function petAnimations(file) {
  const lilith = /^lilith\.(webp|png)$/i.test(file);
  return {
    idle: animation(0, 6, 5), right: animation(1, 8, 10), left: animation(2, 8, 10),
    wave: animation(3, 4), jump: animation(4, 5, 8), yawn: animation(5, 8, 5),
    curious: animation(8), thinking: animation(lilith ? 8 : 7),
    writing: animation(lilith ? 7 : 6, 6, lilith ? 8 : 6),
    sleep: lilith ? animation(6, 6, 3) : animation(0, 6, 2),
  };
}

export function nextPetId(ids, previous, random = Math.random) {
  const unique = [...new Set(ids)];
  const pool = unique.length > 1 ? unique.filter((id) => id !== previous) : unique;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? null;
}

export function intersects(a, b, padding = 0) {
  return a.x < b.x + b.width + padding && a.x + a.width > b.x - padding &&
    a.y < b.y + b.height + padding && a.y + a.height > b.y - padding;
}

export function fits(point, bounds, size, obstacles = []) {
  const box = { ...point, width: size, height: size };
  return point.x >= bounds.x && point.y >= bounds.y &&
    point.x + size <= bounds.x + bounds.width && point.y + size <= bounds.y + bounds.height &&
    !obstacles.some((rect) => intersects(box, rect, 8));
}

export function clearPath(from, to, bounds, size, obstacles) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 8));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    if (!fits({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, bounds, size, obstacles)) return false;
  }
  return true;
}

export function safeDestination(point, candidates, bounds, size, obstacles) {
  return candidates.filter((candidate) => fits(candidate, bounds, size, obstacles))
    .sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y))[0] ?? null;
}

export function gestureAction(pointer, x, y, now) {
  const distance = Math.hypot(x - pointer.x, y - pointer.y);
  if (pointer.type === "mouse") return distance > 6 ? "drag" : "pending";
  if (now - pointer.at < 350) return distance > 6 ? "scroll" : "pending";
  return distance > 6 ? "drag" : "hold";
}

export function turnIsCurrent(token, current, sessionId) {
  return !!token && token.id === current?.id && token.sessionId === sessionId;
}
