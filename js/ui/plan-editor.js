import { node, button, field } from './memory-ui.js';
import { newLoreId } from '../lore-lines.js';
import { validateSchedule, scheduleRange, planStatus, selectScheduledPlan, fitScheduledPlan } from '../scheduled-plan.js';
import { countTokens } from '../tokenizer.js';

export function renderPlanEditor(editor, entry, {date,budget,save,remove,cancel}) {
  const schedule = entry.schedule;
  const dates = node('div',null,'settings-grid');
  const start = field('Start date · D/M/YYYY',schedule.start), end = field('End date · D/M/YYYY',schedule.end);
  start.input.addEventListener('input',()=>schedule.start=start.input.value.trim());
  end.input.addEventListener('input',()=>schedule.end=end.input.value.trim());
  dates.append(start.wrap,end.wrap);editor.append(dates);
  const eventStatus = node('div',null,'memory-actions');
  const renderEventStatus = () => {
    eventStatus.replaceChildren(node('span',schedule.status==='completed' ? 'Completed · all phases excluded' : 'Pending · '+planStatus(schedule,date),'muted'),button(schedule.status==='completed' ? 'Reopen event' : 'Complete event',()=>{schedule.status=schedule.status==='completed' ? 'pending' : 'completed';renderEventStatus();renderPreview();}));
  };
  editor.append(eventStatus,node('p','Complete/Reopen changes take effect when you Save. Passing a date never completes an event or phase.','muted'));
  const overview = field('Shared event overview',entry.sections.text.text,{textarea:true});
  overview.input.placeholder='Brief shared goals and context. Put phase-specific actions below.';
  overview.input.addEventListener('input',()=>{entry.sections.text.text=overview.input.value;Object.assign(entry.sections.text,{kind:'canon',origin:'user',cutoff:null});});editor.append(overview.wrap);
  const phases = node('div',null,'plan-phases');editor.append(node('h3','Phases'),node('p','Load active and overdue phases plus those starting within seven story days. Phase dates must fit inside the event. Overlapping phases are allowed.','muted'),phases);
  const renderPhases = () => {
    phases.replaceChildren();
    for(const phase of schedule.phases) {
      const panel=node('section',null,'lore-section');
      const title=field('Phase title',phase.title), a=field('Start date · D/M/YYYY',phase.start), b=field('End date · D/M/YYYY',phase.end), text=field('Phase instructions',phase.text,{textarea:true});
      for(const [control,key] of [[title,'title'],[a,'start'],[b,'end'],[text,'text']])control.input.addEventListener('input',()=>phase[key]=control.input.value);
      const range=node('div',null,'settings-grid');range.append(a.wrap,b.wrap);
      panel.append(title.wrap,range,text.wrap,node('p',scheduleRange(phase)+' · '+planStatus(phase,date),'muted'),button(phase.status==='completed' ? 'Reopen phase' : 'Complete phase',()=>{phase.status=phase.status==='completed' ? 'pending' : 'completed';renderPhases();renderPreview();},'btn small'),button('Remove phase',()=>{schedule.phases=schedule.phases.filter(p=>p.id!==phase.id);renderPhases();renderPreview();},'btn small danger'));phases.append(panel);
    }
  };
  editor.append(button('+ Add phase',()=>{schedule.phases.push({id:newLoreId('phase'),title:'',start:schedule.start,end:schedule.end,text:'',status:'pending'});renderPhases();},'btn small'));
  const preview=node('details'), previewText=node('pre',null,'context-text'), status=node('p','','muted');
  preview.append(node('summary','Preview scheduled instructions'),status,previewText);editor.append(preview);
  let previewVersion=0;
  async function renderPreview() {
    const version=++previewVersion;
    try {
      validateSchedule(schedule);
      const selected=selectScheduledPlan([entry],date),fit=await fitScheduledPlan(selected.selected,budget,countTokens);
      if(version!==previewVersion || !editor.contains(preview))return;
      status.textContent=[date ? 'Story date: '+date : 'Story date unavailable',`${fit.tokens} / ${budget} tokens`,...selected.warnings,...fit.skipped.map(p=>(p.phaseTitle || p.name)+': '+p.reason)].join(' · ');
      previewText.textContent=fit.text || 'No scheduled instructions selected.';
    } catch(error) {if(version===previewVersion){status.textContent=error.message;previewText.textContent='';}}
  }
  editor.addEventListener('input',renderPreview);
  editor.append(node('p','The fixed plan stays separate. Move dated instructions here after reviewing this preview to avoid sending them twice.','muted'));
  const footer=node('footer',null,'memory-actions');footer.append(button('Delete event',remove,'btn danger'),button('Cancel',cancel),button('Save',()=>{validateSchedule(schedule);return save();},'btn primary'));editor.append(footer);
  renderEventStatus();renderPhases();void renderPreview();
}
