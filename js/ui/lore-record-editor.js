import { RECORD_CATEGORIES, recordSources, reconcileRecords, resolveRecord, archivedRecord, approvedRecord, approveRecord, approveSupersession, fingerprint } from '../lore-records.js';
import { usableLore } from '../continuity.js';
import { newLoreId } from '../lore-lines.js';
import { node, field, button } from './memory-ui.js';

export function renderRecordEditor(parent,entry,{entries=[],messages=[],session={},onChange=()=>{}}={}) {
  const host=node('section',null,'lore-section');parent.append(host);
  const available=()=>usableLore([entry],messages,session).entries[0];
  const eligible=r=>resolveRecord(available(),r);
  function render() {
    Object.assign(entry,reconcileRecords(entry));host.replaceChildren(node('h3','Selectable information'),node('p','Cores load when this subject is relevant. Pins request this passage every turn within its book budget. Save after reviewing.','muted'));
    const records=entry.recordLayout.records;
    for(const category of RECORD_CATEGORIES) {
      const list=records.filter(r=>r.category===category);if(!list.length)continue;
      const group=node('details');group.append(node('summary',category+' · '+list.length));host.append(group);
      for(const r of list) {
        const resolved=resolveRecord(entry,r),valid=eligible(r),box=node('section',null,'lore-section');
        box.append(node('p',approvedRecord(available(),r)?'Approved core':r.coreCandidate?'Core awaiting review':'Detail','muted'));
        if(!valid.valid)box.append(node('p',valid.reason,'memory-warning'));
        for(const s of resolved.sources)box.append(node('pre',s.section+(s.lineId ? ' · '+s.lineId : '')+'\n'+s.text));
        const complete=node('details');complete.append(node('summary','Review complete sources and qualifications'));
        for(const source of new Map(resolved.sources.map(s=>[s.sourceId,s.source])).values())complete.append(node('pre',source.section+'\n'+source.data.text));
        if(resolved.valid)box.append(complete);
        if(!resolved.valid){box.append(node('p',resolved.reason+'; select the current sources to create a fresh bundle.','memory-warning'));for(const source of archivedRecord(entry,r))box.append(node('pre','Previous source · '+source.section+'\n'+source.text));}
        const type=node('select');for(const value of RECORD_CATEGORIES){const o=node('option',value);o.value=value;type.append(o);}type.value=r.category;type.addEventListener('change',()=>{r.category=type.value;onChange();});box.append(type);
        const candidate=field('Propose as core','',{type:'checkbox'});candidate.input.checked=!!r.coreCandidate;candidate.input.addEventListener('change',()=>{r.coreCandidate=candidate.input.checked;delete r.approval;onChange();});
        const pin=field('Pin every request','',{type:'checkbox'});pin.input.checked=!!r.pinned;pin.input.addEventListener('change',()=>{r.pinned=pin.input.checked;onChange();});box.append(candidate.wrap,pin.wrap);
        const related=node('details');related.append(node('summary','Related subjects'));
        for(const other of entries.filter(e=>e.id!==entry.id)){const f=field(other.name,'',{type:'checkbox'});f.input.checked=r.relatedEntryIds.includes(other.id);f.input.addEventListener('change',()=>{r.relatedEntryIds=f.input.checked?[...new Set([...r.relatedEntryIds,other.id])]:r.relatedEntryIds.filter(id=>id!==other.id);onChange();});related.append(f.wrap);}box.append(related);
        const triggers=field('Specific trigger phrases (one per line)',r.triggers.join('\n'),{textarea:true});triggers.input.addEventListener('change',()=>{r.triggers=[...new Set(triggers.input.value.split('\n').map(s=>s.trim()).filter(Boolean))];onChange();});box.append(triggers.wrap);
        const replaces=node('details');replaces.append(node('summary','Explicit replacement (review required)'));
        for(const old of records.filter(o=>o.id!==r.id&&resolveRecord(entry,o).valid)){const f=field(resolveRecord(entry,old).text,'',{type:'checkbox'});f.input.checked=(r.supersedes ?? []).includes(old.id);f.input.addEventListener('change',()=>{r.supersedes=f.input.checked?[...(r.supersedes ?? []),old.id]:(r.supersedes ?? []).filter(id=>id!==old.id);delete r.replacementApproval;onChange();});replaces.append(f.wrap);}
        replaces.append(button('Approve selected replacements',()=>{if(!eligible(r).valid || (r.supersedes ?? []).some(id=>!eligible(records.find(v=>v.id===id)).valid))throw new Error('Review source evidence first');approveSupersession(entry,r);onChange();render();},'btn small'));box.append(replaces);
        const reviewed=field('I reviewed the complete passage and its conditions','',{type:'checkbox'});box.append(reviewed.wrap);
        box.append(button('Approve this core',()=>{if(!reviewed.input.checked)throw new Error('Review this core before approving it');if(!eligible(r).valid)throw new Error('Review source evidence first');approveRecord(entry,r);onChange();render();},'btn small'),button('Remove core approval',()=>{delete r.approval;onChange();render();},'btn small'),button('Remove grouping',()=>{entry.recordLayout.records=records.filter(o=>o.id!==r.id);onChange();render();},'btn small'));
        group.append(box);
      }
    }
    const builder=node('details');builder.append(node('summary','Create a source bundle'));host.append(builder);
    const sources=recordSources(entry).filter(s=>s.data.text?.trim()),picker=node('select');for(const s of sources){const o=node('option',s.section+(s.lineId?' · '+s.lineId:' · base text'));o.value=s.id;picker.append(o);}
    const passage=field('Select a passage, or include the complete source','',{textarea:true});passage.input.readOnly=true;const update=()=>{passage.input.value=sources.find(s=>s.id===picker.value)?.data.text ?? '';};picker.addEventListener('change',update);update();
    const pending=[],preview=node('div');builder.append(picker,passage.wrap,button('Add passage',()=>{const s=sources.find(s=>s.id===picker.value);if(!s)throw new Error('Choose a source');const selected=s.lineId==null&&passage.input.selectionEnd>passage.input.selectionStart;const start=selected?passage.input.selectionStart:0,end=selected?passage.input.selectionEnd:s.data.text.length;pending.push({sourceId:s.id,start,end,fingerprint:fingerprint(s)});preview.append(node('pre',s.data.text.slice(start,end)));},'btn small'),preview,button('Create bundle',()=>{if(!pending.length)throw new Error('Add a source passage first');entry.recordLayout.records.push({id:newLoreId('record'),category:'constraint',coreCandidate:true,relatedEntryIds:[],triggers:[],sources:pending});onChange();render();},'btn small'));
  }
  render();return host;
}
