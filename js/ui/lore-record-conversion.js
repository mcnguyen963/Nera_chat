import { convertLayout, reconcileRecords } from '../lore-records.js';
import { toJson } from '../lore-format.js';
import { loadPrompt } from '../system-prompts.js';
import * as store from '../lore-store.js';
import { currentUid } from '../auth.js';
import { renderRecordEditor } from './lore-record-editor.js';
import { node, field, button, subSheet, download, toast } from './memory-ui.js';

export function addRecordConversion(parent,{snapshot,prepare,isCurrent}) {
  const box=node('section',null,'lore-section');box.append(node('h3','Selective lorebook records'),node('p','Export your sources and the conversion prompt, review each proposed core, then migrate this story. Existing stories keep their current selection until migrated.','muted'));parent.append(box);
  box.append(button('Export sources + conversion prompt',async()=>{const live=await prepare();const entries=live.entries.map(({schemaVersion,recordLayout,...e})=>e),json=toJson(entries,{title:live.session.title});download(json,'lorebook-sources.json','application/json');download(await loadPrompt('lorebook-layout.md'),'lorebook-layout-prompt.txt');}),button('Review layout / migrate',async()=>{
    const owner=currentUid(),sourceId=snapshot()?.session?.id,original=await prepare();if(currentUid()!==owner||original.session.id!==sourceId||!isCurrent(sourceId))throw new Error('Story or account changed; reopen conversion');
    const s=subSheet('Review selective lorebook layout'),body=node('div',null,'memory-content');s.dialog.append(body);
    const input=field('Paste layout JSON (optional; empty keeps complete sources)','',{textarea:true}),file=node('input');file.type='file';file.accept='.json';file.addEventListener('change',async()=>{if(file.files?.[0])input.input.value=await file.files[0].text();});body.append(input.wrap,file);
    const result=node('div');body.append(result);let proposal=null;
    body.append(button('Preview conversion',()=>{
      proposal=input.input.value.trim()?convertLayout(original.entries,input.input.value):{entries:original.entries.map(reconcileRecords),warnings:[],reviewNotes:[]};
      result.replaceChildren(node('p',proposal.entries.length+' subjects; all source text remains available. Approve cores individually below.'));
      for(const warning of [...proposal.warnings,...proposal.reviewNotes])result.append(node('p',warning,'memory-warning'));
      for(const entry of proposal.entries){const d=node('details');d.append(node('summary',entry.name));renderRecordEditor(d,entry,{entries:proposal.entries,messages:original.messages,session:original.session});result.append(d);}
    }),button('Migrate this story',async()=>{
      if(!proposal)throw new Error('Preview the conversion first');if(currentUid()!==owner||!isCurrent(original.session.id))throw new Error('Story or account changed; reopen conversion');
      await store.migrateRecords(original.session.id,structuredClone(proposal.entries),{expectedRevision:original.session.loreRevision ?? 0});s.hide();toast('Selective record lorebooks activated.');
    },'btn primary'));
  }));
  if(snapshot()?.session?.loreSchemaVersion===3)box.append(button('Return to legacy selection',async()=>{const sourceId=snapshot()?.session?.id,live=await prepare();if(!isCurrent(sourceId)||live.session.id!==sourceId)throw new Error('Story changed');await store.rollbackRecords(live.session.id,{expectedRevision:live.session.loreRevision ?? 0});toast('Legacy selection restored with current source information.');}));
}
