// Compare saved documents independently of Firestore map ordering and Timestamp prototypes.
export function cardFingerprint(value) {
  const ordered = v => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k,ordered(v[k])])) : v;
  return JSON.stringify(ordered(value));
}
