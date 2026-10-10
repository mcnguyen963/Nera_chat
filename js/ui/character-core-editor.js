import { coreSource, reviewCore, resolveCore, CORE_COVERAGE } from '../character-core.js';
import { SECTION_KEYS } from '../lore-lines.js';
import { node, button, field } from './memory-ui.js';
// The editor only records references to text the user can inspect. It has no
// model boundary, inference, or implicit approval path.
export function renderCoreEditor(parent, entry, onChange = () => {}, evidenceContext = null) {
  const host=node('details');host.append(node('summary','Reviewed character core references'));
  const body=node('div');host.append(body);parent.append(host);
  let pending=[];
  function render() {
    body.replaceChildren(node('p','A core covers defining personality, essential behavioral/capability constraints and minimal appearance. Keep related claims together, including conditions, negations and knowledge boundaries. Core bundles are indivisible. Save the card after review.','muted'));
    for(const bundle of entry.coreReferences ?? []) {
      const resolved=resolveCore(entry,bundle,evidenceContext),box=node('div');
      box.append(node('p',resolved.valid ? 'Reviewed · '+bundle.coverage.join(', ') : 'Needs review · '+resolved.reason,resolved.valid ? 'muted' : 'memory-warning'));
      for(const r of bundle.sources ?? []) {
        const s=entry.sections[r.section],source=r.lineId==null ? s?.text : s?.lines.find(l=>l.id===r.lineId)?.text;
        box.append(node('pre',r.section+' · '+(source==null ? 'Source deleted' : source.slice(r.start,r.end))));
      }
      box.append(button('Remove reference',()=>{entry.coreReferences=entry.coreReferences.filter(b=>b.id!==bundle.id);onChange();render();},'btn small'));body.append(box);
    }
    const picker=node('select');
    for(const key of SECTION_KEYS.characters) {
      const s=entry.sections[key];if(!s)continue;
      if(s.text) {const o=node('option',key+' · section text');o.value=JSON.stringify({section:key,lineId:null});picker.append(o);}
      for(const l of s.lines ?? []) {const o=node('option',key+' · '+(l.turn==null ? 'note' : 'T'+l.turn)+' · '+l.text.slice(0,70));o.value=JSON.stringify({section:key,lineId:l.id});picker.append(o);}
    }
    const passage=field('Source passage (select text, or include the whole source)','',{textarea:true});passage.input.readOnly=true;passage.input.rows=6;
    const update=()=>{const r=picker.value ? JSON.parse(picker.value) : null;const s=r && entry.sections[r.section];passage.input.value=r ? r.lineId==null ? s.text : s.lines.find(l=>l.id===r.lineId).text : '';};picker.addEventListener('change',update);update();
    body.append(picker,passage.wrap,button('Add source to bundle',()=>{
      if(!picker.value)throw new Error('Add source text to this card first.');const r=JSON.parse(picker.value),input=passage.input;
      const selected=input.selectionEnd>input.selectionStart && r.lineId==null;
      pending.push(coreSource(entry,r.section,r.lineId,selected ? input.selectionStart : 0,selected ? input.selectionEnd : null));render();
    },'btn small'));
    for(const r of pending) {const s=entry.sections[r.section],text=r.lineId==null ? s.text : s.lines.find(l=>l.id===r.lineId)?.text;body.append(node('pre',r.section+' · '+(text ?? '').slice(r.start,r.end)));}
    if(pending.length) {
      const checks=CORE_COVERAGE.map(key=>{const f=field('This bundle covers '+key,'',{type:'checkbox'});body.append(f.wrap);return [key,f.input];});
      const reviewed=field('I reviewed the complete bundle; all conditions and negations accompany their claims','',{type:'checkbox'});body.append(reviewed.wrap);
      body.append(button('Approve core bundle',()=>{if(!reviewed.input.checked)throw new Error('Review the complete bundle before approving it.');entry.coreReferences ??=[];const bundle=reviewCore(entry,pending,checks.filter(([,c])=>c.checked).map(([k])=>k));const valid=resolveCore(entry,bundle,evidenceContext);if(!valid.valid)throw new Error(valid.reason);entry.coreReferences.push(bundle);pending=[];onChange();render();},'btn primary'),button('Discard pending bundle',()=>{pending=[];render();}));
    }
  }
  render();return host;
}
