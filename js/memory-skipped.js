// Keep a bounded, text-only record for the memory panel; never store raw model output here.
export function limitSkippedNotes(skipped = []) {
  return skipped.slice(0,10).map(note => ({
    card:String(note.card ?? note.name ?? note.entryId ?? '').slice(0,80),
    reason:String(note.reason === 'card storage full' ? 'card full' : note.reason ?? 'not a note').slice(0,95),
  }));
}
export function skippedNotesText(skipped = []) {
  if (!skipped.length) return '';
  return `${skipped.length} ${skipped.length === 1 ? 'note was' : 'notes were'} skipped: `+skipped.map(note =>
    note.reason === 'card full' ? `card '${note.card || 'unknown'}' is full — reorganize it` : (note.card ? `card '${note.card}': ` : '')+note.reason
  ).join('; ')+'.';
}
