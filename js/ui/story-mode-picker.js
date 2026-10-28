import {subSheet,node,button} from './memory-ui.js';
import {storyModes,createStoryMode} from '../story-modes.js';

export function openStoryModePicker({createBlank,onCreated,onClose=()=>{},isCurrent=()=>true}) {
  let working=false;
  const sheet=subSheet('New story',{close:()=>{if(working)return false;onClose();return true;}});
  const body=node('div',null,'memory-content story-mode-picker');
  body.append(node('p','Choose a beginning for Nera, or start with a blank story.','muted'));
  const cards=node('div',null,'story-mode-cards');
  for(const mode of storyModes){
    const card=node('article',null,'story-mode-card');
    card.append(node('h3',mode.title),node('p',mode.description));
    const preview=node('details');preview.append(node('summary','Read the opening'),node('p',mode.opening,'story-mode-opening'));card.append(preview);
    card.append(button('Start this story',async()=>{
      if(working)return;if(!isCurrent())throw new Error('The account changed or a story is busy. Close this picker and try again.');working=true;
      try {const id=await createStoryMode(mode.id,{isCurrent});working=false;sheet.hide();onCreated(id);}
      finally{working=false;}
    },'btn primary'));
    cards.append(card);
  }
  body.append(cards,button('Blank story',async()=>{
    if(working)return;if(!isCurrent())throw new Error('The account changed or a story is busy. Close this picker and try again.');
    const title=prompt('Session title:','Untitled story');if(title===null)return;
    working=true;try{const id=await createBlank(title.trim() || 'Untitled story');working=false;sheet.hide();onCreated(id);}finally{working=false;}
  }));
  sheet.dialog.append(body);
}
