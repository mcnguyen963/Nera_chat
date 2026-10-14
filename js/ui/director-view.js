import { state } from '../state.js';
import { currentUid } from '../auth.js';
import { requestSource } from '../continuity.js';
import { seedDirectorState, validateDirectorState } from '../director-state.js';
import { resetDirectorState, discardPendingDirector } from '../director-store.js';
import * as chat from './chat-view.js';
const {prepareMemorySnapshot,syncChatData}=chat;
import { node, button, subSheet, toast } from './memory-ui.js';
export async function openDirectorState() {
  if(state.busy)return toast('Finish the current reply first.');
  try {
    const live=await prepareMemorySnapshot(),sid=state.sessionId,uid=currentUid();
    if(!live)return;
    const value=structuredClone(live.session.directorState ?? seedDirectorState(live.session,live.messages,live.entries));
    const dialog=subSheet('Director · live state'),body=node('div',null,'memory-content');
    const guard=()=>{if(sid!==state.sessionId || uid!==currentUid() || state.busy)throw new Error('Story changed or another action is running. Reopen live state.');};
    const field=(label,value,tag='input')=>{const wrap=node('label',label),input=node(tag);input.value=value ?? '';if(tag==='textarea')input.rows=3;wrap.append(input);body.append(wrap);return input;};
    body.append(node('p',live.session.directorNeedsReview?'History changed. Review and save the current state before continuing.':'Changes apply to this story. Older promises can be added below.','muted'));
    const date=field('Date (day/month/year; empty means unknown)',value.scene.date),hour=field('Game hour (1–24; empty means unknown)',value.scene.hour),location=field('Location',value.scene.location),present=field('Present characters (one full name per line)',value.scene.present.join('\n'),'textarea');
    const event=field('Current event',value.event?.name),phase=field('Event phase',value.event?.phase);
    const read=[];
    for(const group of ['decisions','threads','commitments']){
      body.append(node('h3',group[0].toUpperCase()+group.slice(1)));
      const list=node('div');body.append(list);
      const add=item=>{const row=node('div',null,'director-ledger-row'),text=node('textarea'),trigger=node('input'),status=node('select');text.value=item.text;trigger.value=item.trigger ?? '';trigger.placeholder='Trigger or condition';
        for(const v of ['open','active','waiting','ready','closed','cancelled']){const opt=node('option',v);opt.value=v;status.append(opt);}status.value=item.status;
        const label=node('label','Commitment or unresolved item');label.append(text);const condition=node('label','Trigger');condition.append(trigger);row.append(label,condition,status);list.append(row);
        read.push(()=>({group,item:{...item,text:text.value.trim(),trigger:trigger.value.trim(),status:status.value}}));};
      value[group].forEach(add);body.append(button('Add '+group.replace(/s$/,''),()=>add({id:'manual_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),text:'',status:'open',trigger:''}),'btn small'));
    }
    const error=node('p',null,'auth-message');body.append(error);
    if(live.session.directorPending){body.append(node('p','A narration contract is pending. Continue or regenerate its reply, or discard the contract before editing state.','muted'),button('Discard pending contract',async b=>{b.disabled=true;try{guard();await discardPendingDirector(sid,requestSource(live.session));await syncChatData();dialog.hide();}catch(e){error.textContent=e.message;b.disabled=false;}}));}
    else body.append(button('Save live state',async b=>{b.disabled=true;try{guard();const next={...value,scene:{date:date.value.trim() || null,hour:hour.value.trim()?Number(hour.value):null,location:location.value.trim() || null,present:present.value.split('\n').map(n=>n.trim()).filter(Boolean)},event:event.value.trim()?{id:value.event?.id ?? 'manual-event',name:event.value.trim(),phase:phase.value.trim()}:null};for(const group of ['decisions','threads','commitments'])next[group]=read.map(fn=>fn()).filter(r=>r.group===group && r.item.text).map(r=>r.item);await resetDirectorState(sid,next,requestSource(live.session));await syncChatData();dialog.hide();toast('Director state saved.');}catch(e){error.textContent=e.message;b.disabled=false;}},'btn primary'));
    dialog.dialog.append(body);
  }catch(error){toast(error.message);}
}
