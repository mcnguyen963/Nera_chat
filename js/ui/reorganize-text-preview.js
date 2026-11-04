import { sectionLabel } from '../lore-select.js';
import { node, field } from './memory-ui.js';

export function renderTextProposals(parent,changes,protagonist) {
  for(const change of changes) {
    const section=node('section'),approval=field('Approve base text replacement · '+(sectionLabel(change.section,protagonist)||'Text'),'',{type:'checkbox'});
    approval.input.checked=change.include===true;
    approval.input.addEventListener('change',()=>{change.include=approval.input.checked;});
    const columns=node('div',null,'reorganize-columns'),before=node('div',null,'reorganize-before'),after=node('div',null,'reorganize-after');
    before.append(node('h4','Before'),node('pre',change.before));after.append(node('h4','Proposed text'),node('pre',change.after));
    columns.append(before,after);section.append(approval.wrap,columns);parent.append(section);
  }
}
