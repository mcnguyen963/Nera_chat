import { stripThinking } from './thinking-text.js';
import { isNamed, SECTION_MAP, sectionKey } from './lore-lines.js';

// This directive belongs only to explicit reorganize previews. Extraction never
// accepts it, and parsing alone cannot authorize a base-text edit.
export function parseReorganizeAnswer(text,entries,sections) {
  const notes=[],proposals=[],skipped=[],seen=new Set();
  const books={char:'characters',character:'characters',characters:'characters',loc:'locations',location:'locations',locations:'locations',fact:'facts',facts:'facts',event:'events',events:'events'};
  for(const [index,source] of stripThinking(text).split(/\r?\n/).entries()) {
    if(!/^\s*TEXT\b/i.test(source)){notes.push(source);continue;}
    const skip=reason=>skipped.push({line:index+1,text:source,reason});
    const match=source.trim().match(/^TEXT\s+\[([a-z]+)\]\s+([^|]+)\|\s*([^:]+):\s*(.+)$/i);
    if(!match){skip('invalid base-text proposal');continue;}
    const book=books[match[1].toLowerCase()],name=match[2].trim(),label=match[3].trim().toLowerCase(),after=match[4].trim();
    const matches=entries.filter(e=>e.book===book && isNamed(e,name));
    if(matches.length!==1){skip('base-text proposal must name one selected card');continue;}
    const entry=matches[0],key=sectionKey(book,label);
    if(!(SECTION_MAP[book]?.[label] || ['facts','events'].includes(book)&&label==='text') || !sections[entry.id]?.includes(key) || !entry.sections[key]){skip('base-text proposal must name a selected section');continue;}
    const id=JSON.stringify([entry.id,key]);
    if(seen.has(id) || !after || after.length>50000){skip('duplicate or oversized base-text proposal');continue;}
    seen.add(id);proposals.push({entryId:entry.id,section:key,before:entry.sections[key].text,after,include:false});
  }
  return {notes:notes.join('\n'),proposals,skipped};
}
