import {node,field} from './memory-ui.js';
import {normalizeThreadMeta,threadSummary} from '../thread-lifecycle.js';
export function renderThreadEditor(parent,item,{onChange=()=>{}}={}) {
  const details=node('details');details.append(node('summary','Thread timing and outcome'));
  const meta=normalizeThreadMeta(item.threadMeta) ?? normalizeThreadMeta({});
  const kind=node('select');for(const k of ['ongoing','appointment','commitment']){const option=node('option',k);option.value=k;kind.append(option);}kind.value=meta.kind;
  const label=node('label','Kind');label.append(kind);details.append(label);
  const date=field('Scheduled date · D/M/YYYY',meta.dueDate ?? ''),time=field('Scheduled time · HH:mm (optional)',meta.dueTime ?? ''),people=field('Participants · comma separated',meta.participants.join(', ')),place=field('Meeting location (optional)',meta.location ?? '');
  const outcome=node('select');for(const [value,text] of [['','Not closed'],['resolved','Resolved'],['cancelled','Cancelled'],['expired-unresolved','Expired — unresolved'],['background-unresolved','Background — unresolved']]){const o=node('option',text);o.value=value;outcome.append(o);}outcome.value=meta.outcome ?? '';
  const outcomeLabel=node('label','Outcome');outcomeLabel.append(outcome);details.append(date.wrap,time.wrap,people.wrap,place.wrap,outcomeLabel,node('p','Appointments and one-off commitments leave active context three story days after their scheduled time. Fixed Plans and ongoing goals do not expire.','muted'));
  const update=()=>{item.threadMeta={kind:kind.value,dueDate:date.input.value.trim()||null,dueTime:time.input.value.trim()||null,participants:people.input.value.split(',').map(n=>n.trim()).filter(Boolean),location:place.input.value.trim()||null,outcome:outcome.value||null};item.threadMetaSource=null;if(outcome.value)item.status='closed';else if(item.status==='closed')item.status='open';onChange();};
  for(const input of [kind,date.input,time.input,people.input,place.input,outcome])input.addEventListener('input',update);
  for(const input of [kind,outcome])input.addEventListener('change',update);
  parent.append(details);if(threadSummary(item))parent.append(node('p',threadSummary(item),'muted'));
  if(item.threadTimingNeedsReview)parent.append(node('p','Timing evidence changed. Review the appointment before using its deadline.','memory-warning'));
}
