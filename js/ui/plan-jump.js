import { node, button, field, subSheet } from './memory-ui.js';
import { planDate, validatePlanJump } from '../scheduled-plan.js';
import { latestScene } from '../scene.js';
import { normalizeMemory } from '../memory-settings.js';

export function createPlanJumpControl(control, {story,messages,owner,busy,changed}) {
  let jump = null;
  const currentDate = () => latestScene(messages(),Infinity,story()?.memory?.startingScene).scene?.when;
  const refresh = () => {
    const mem=normalizeMemory(story()?.memory);
    control.hidden=!mem.scene || mem.calendar.mode!=='modern';
    if(control.hidden)jump=null;
    control.disabled=busy();
    control.textContent=jump ? 'Skip to '+jump.to : 'Time skip…';
  };
  control.addEventListener('click',()=>{
    if(busy() || !story())return;
    const sourceId=story().id,sourceOwner=owner(),sourceDate=currentDate();
    const dialog=subSheet('TIME SKIP',{compact:true}),body=node('div',null,'memory-content'),date=field('Destination date · D/M/YYYY',jump?.to ?? ''),warning=node('p','','memory-warning');
    body.append(node('p','Confirm the destination before sending. Scheduled phases along the jump and the following seven days will be considered.','muted'),node('p','Current story date: '+(sourceDate || 'unknown'),'muted'),date.wrap,warning);
    body.append(button('Confirm destination',()=>{
      if(owner()!==sourceOwner || story()?.id!==sourceId || currentDate()!==sourceDate || busy()){warning.textContent='Story changed. Close this dialog and choose the destination again.';return;}
      try {jump=validatePlanJump({from:planDate(sourceDate),to:date.input.value});refresh();changed();dialog.hide();} catch(error){warning.textContent=error.message;}
    },'btn primary'),button('Clear time skip',()=>{jump=null;refresh();changed();dialog.hide();}),button('Cancel',dialog.hide));dialog.dialog.append(body);date.input.focus();
  });
  return {
    refresh,
    reset() {jump=null;refresh();},
    get() {
      if(!jump)return null;
      if(planDate(currentDate())!==jump.from)throw new Error('The story date changed. Choose the time skip destination again.');
      return validatePlanJump(jump);
    },
    preview:()=>jump,
  };
}
