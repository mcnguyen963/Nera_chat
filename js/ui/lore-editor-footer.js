import { countTokens } from '../tokenizer.js';
import { renderEntry, sectionLabel } from '../lore-select.js';
import { capLoreNotes, noteOmissions } from '../lore-note-window.js';

export async function updateLoreFooter(label,entry,mem,isCurrent) {
  const tokens=await countTokens(renderEntry(entry)),budget=mem.books[entry.book].budget;
  if(!isCurrent())return;
  const lines=Object.values(entry.sections).reduce((n,s)=>n+s.lines.length,0);
  label.textContent=`${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens · ${lines} lines`;
  label.style.color=tokens>budget ? 'var(--danger)' : '';
  const counts=new Map();
  for(const omission of noteOmissions(capLoreNotes(entry,mem.loreNotesPerSection)))counts.set(omission.section,(counts.get(omission.section) ?? 0)+1);
  for(const [key,count] of counts)label.textContent+=` · ${sectionLabel(key,mem.protagonist) || 'Notes'}: ${count} older notes hidden from the narrator`;
  if(new TextEncoder().encode(JSON.stringify(entry)).length>700000)label.textContent+=' · Too big to store much longer — reorganize it';
}
