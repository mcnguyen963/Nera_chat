export function createDeviceUploadView(ctx) {
async function openDeviceStoryUpload() {
  if(!ctx.session){ctx.showTransientInfo('Open a story first.');return;}
  if(ctx.busy || ctx.editingState || ctx.directStorySaves.size){ctx.showTransientInfo('Finish the current reply or edit first.');return;}
  const sid=ctx.state.sessionId,owner=ctx.currentUid(),epoch=ctx.historyEpoch;
  let closed=false,uploading=false,downloadedCopy=null,cloudCopy=null;
  const dialog=ctx.subSheet('Force upload this device',{close:()=>{if(uploading)return false;closed=true;return true;}});
  const body=ctx.node('div',null,'memory-content'),status=ctx.node('p','Reading copies stored on this device…','muted');body.append(status);dialog.dialog.append(body);
  const active=()=>!closed && sid===ctx.state.sessionId && owner===ctx.currentUid() && epoch===ctx.historyEpoch;
  try {
    const loaded=await Promise.allSettled([ctx.loadChatCache(owner,sid),ctx.loadStoryData(owner,sid),ctx.storyQueueStorage.load(owner,sid),ctx.cachedLoreSnapshot(owner,sid),ctx.loadUnsavedReply(owner,sid)]);
    const [cached,aux,outbox,lore,savedReply]=loaded.map(result=>result.status==='fulfilled'?result.value:null);
    if(!active()){dialog.hide();return;}
    const store=ctx.storyStore(sid),current=store?.view ?? (ctx.historyMessages && ctx.historyRevision===(ctx.session.historyRevision ?? 0)?{session:ctx.session,messages:ctx.historyMessages,turns:aux?.turns}:null);
    const localLore=lore ?? (ctx.loreStatus==='ok' && ctx.loreSessionId===sid?{initialized:true,entries:ctx.loreEntries,schemaVersion:ctx.session.loreSchemaVersion ?? 2,generation:ctx.session.loreGeneration ?? null}:null);
    const unsavedReply=ctx.unsavedReplies.get(ctx.unsavedKey(owner,sid)) ?? savedReply;
    const copies=ctx.deviceStoryCopies({sid,current,cached,aux,outbox,storySettings:ctx.state.storySettings,loreSnapshot:localLore,unsavedReply:unsavedReply?.sid===sid && (!unsavedReply.owner || unsavedReply.owner===owner)?unsavedReply:null});
    if(!copies.length){status.textContent='No complete story copy was found on this device. Recent messages alone cannot safely replace Firebase.';return;}
    status.textContent='Choose the chat history to upload with this device’s memory, lorebooks, and prompts. This replaces the current Firebase story. It cannot recreate turns that are no longer stored here.';
    const picker=ctx.node('select');picker.setAttribute('aria-label','Device story copy');for(const [index,copy]of copies.entries()){const option=ctx.node('option',copy.label+' · '+copy.snapshot.messages.length+' messages · '+copy.snapshot.lore.length+' lore cards');option.value=String(index);picker.append(option);}picker.value='0';
    const preview=ctx.node('p','','muted'),selected=()=>copies[Number(picker.value)]?.snapshot;
    const render=()=>{const copy=selected(),last=copy?.messages.at(-1);preview.textContent=last?'Last saved text: '+String(last.content).slice(0,240):'';};picker.addEventListener('change',render);render();
    const baseline=ctx.deviceUploadFingerprint();
    const backupButton=ctx.button('Download device backup',()=>{if(!active())throw new Error('Story changed; reopen this dialog.');const copy=selected();ctx.download(JSON.stringify(copy,null,2)+'\n',(copy.session.title || 'story').replace(/[^\w\- ]+/g,'').trim()+'-device-backup.json','application/json');downloadedCopy=copy;});
    const cloudButton=ctx.button('Download previous cloud backup',()=>{if(!active())throw new Error('Story changed; reopen this dialog.');if(!cloudCopy)return;ctx.download(JSON.stringify(cloudCopy,null,2)+'\n','previous-cloud-story-backup.json','application/json');});cloudButton.hidden=true;
    const uploadButton=ctx.button('Replace Firebase with this copy',async()=>{
      if(!active())throw new Error('Story changed; reopen this dialog.');
      const copy=structuredClone(selected());ctx.validateDeviceStory(copy);
      if(!confirm(`Replace this Firebase story with ${copy.messages.length} messages and ${copy.lore.length} lore cards from this device, including memory and prompts? The previous cloud copy will be backed up. Changes from other devices will not be merged.`))return;
      uploading=true;picker.disabled=true;backupButton.disabled=true;
      try{const done=await ctx.forceUploadDeviceStory(copy,{baseline,owner,epoch,backupDownloaded:downloadedCopy===selected(),onProgress:text=>{if(active())status.textContent=text;},onComplete:result=>{cloudCopy=result.cloudBackup;cloudButton.hidden=false;uploadButton.hidden=true;}});if(done)status.textContent='Uploaded to Firebase. Your previous cloud copy is kept in recovery backups. Use Sync latest data on other devices.';}
      finally{uploading=false;picker.disabled=false;backupButton.disabled=false;}
    });
    body.append(picker,preview,backupButton,uploadButton,cloudButton,ctx.node('p','A local backup and a cloud recovery backup are saved before replacement. No AI calls are made.','muted'));
    if(loaded.some(result=>result.status==='rejected'))body.append(ctx.node('p','Some device storage could not be read. Only the complete copies listed above are available.','memory-warning'));
    for(const warning of copies.warnings ?? [])body.append(ctx.node('p',warning,'memory-warning'));
  }catch(error){if(active())status.textContent=error.message;}
}

return openDeviceStoryUpload;
}
