import {fetchProviders, supportsProviders, providerRetryAt} from '../provider-routing.js';

export function initProviderPicker({button,search,list,selected,status,endpoint,apiKey,model,connection,onChange,onReselect}, discover=fetchProviders) {
  let entries=[],request=0,controller=null,fieldIdentity;
  const removed=new Set();
  const identity=()=>JSON.stringify([connection().activeProfileId,endpoint.value,model.value]);
  const settings=()=>({...connection(),endpoint:endpoint.value,apiKey:apiKey.value,modelId:model.value});
  const message=text=>{status.textContent=text;};
  const cancel=()=>{request++;controller?.abort();controller=null;button.disabled=!supportsProviders(endpoint.value);button.textContent='Fetch providers';};
  const makeButton=(label,action,disabled=false)=>{
    const node=document.createElement('button');node.type='button';node.className='btn small';node.textContent=label;node.disabled=disabled;node.addEventListener('click',action);return node;
  };
  const order=()=>connection().providerOrder ?? [];
  function renderResults() {
    const query=search.value.trim().toLowerCase();
    list.replaceChildren(...entries.filter(entry=>!order().includes(entry.tag) && (entry.name+' '+entry.tag).toLowerCase().includes(query)).map(entry=>{
      const row=document.createElement('div');row.className='provider-row';
      const label=document.createElement('span');label.textContent=entry.name+' ('+entry.tag+')';
      row.append(label,makeButton('Add',()=>{
        if(order().length>=10 || order().includes(entry.tag))return;
        if(removed.has(identity()+'|'+entry.tag) || providerRetryAt(settings(),entry.tag)) {
          removed.add(identity()+'|'+entry.tag);onReselect(settings(),entry.tag);
        }
        onChange([...order(),entry.tag]);render();message('Provider selected. Save settings to apply.');
      },order().length>=10));return row;
    }));
  }
  function render() {
    button.disabled=!!controller || !supportsProviders(endpoint.value) || !model.value.trim();
    search.disabled=!supportsProviders(endpoint.value);
    selected.replaceChildren(...order().map((tag,index)=>{
      const row=document.createElement('li');row.className='provider-row';
      const label=document.createElement('span'),name=entries.find(entry=>entry.tag===tag)?.name;
      const retryAt=providerRetryAt(settings(),tag);
      label.textContent=`${index+1}. ${name ? name+' ('+tag+')' : tag}`+(retryAt ? removed.has(identity()+'|'+tag) ? ' · Cooldown resets when saved' : ' · Cooling down until '+new Date(retryAt).toLocaleTimeString() : '');
      const move=offset=>{const next=[...order()];[next[index],next[index+offset]]=[next[index+offset],next[index]];onChange(next);render();};
      row.append(label,makeButton('Move up',()=>move(-1),index===0),makeButton('Move down',()=>move(1),index===order().length-1),makeButton('Remove',()=>{
        removed.add(identity()+'|'+tag);onChange(order().filter(value=>value!==tag));render();message('Provider removed. Save settings to apply.');
      }));return row;
    }));
    renderResults();
  }
  const reset=()=>{fieldIdentity=identity();cancel();entries=[];search.value='';list.replaceChildren();message('');render();};
  const connectionChanged=()=>{if(fieldIdentity===identity())return;fieldIdentity=identity();cancel();entries=[];search.value='';onChange([]);render();message(supportsProviders(endpoint.value)?'Model or endpoint changed. Fetch providers to choose a new order.':'Provider selection is available for OpenRouter endpoints.');};
  button.addEventListener('click',async()=>{
    if(controller || !supportsProviders(endpoint.value) || !model.value.trim())return;
    cancel();const version=request,snapshot=settings(),id=identity();controller=new AbortController();button.disabled=true;button.textContent='Fetching…';message('Fetching providers…');
    const current=()=>version===request && id===identity() && snapshot.apiKey===apiKey.value;
    try {
      const result=await discover(snapshot,{signal:controller.signal});
      if(!current())return;
      entries=result;render();message(entries.length ? 'Add up to 10 providers, then arrange their priority. Save settings to apply.' : 'No providers were listed for this model.');
    } catch(error) {if(current())message(error.message);}
    finally {if(current()){controller=null;button.textContent='Fetch providers';render();}}
  });
  search.addEventListener('input',renderResults);
  for(const field of [endpoint,model]) {
    field.addEventListener('input',connectionChanged);
    field.addEventListener('change',connectionChanged);
  }
  for(const event of ['input','change'])apiKey.addEventListener(event,reset);
  globalThis.addEventListener?.('storage',event=>{if(event.key?.startsWith('nera.provider.cooldown.'))render();});
  return {reset,render,connectionChanged,clear(){removed.clear();reset();}};
}
