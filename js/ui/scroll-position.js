// Keep automatic scrolling and the jump control on the same boundary.
export function isNearBottom(list) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
}
