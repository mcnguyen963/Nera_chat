import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
async function findChrome() {
  const candidates=[process.env.CHROME_BIN,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const cache=join(homedir(),'Library/Caches/ms-playwright');
  for(const name of await readdir(cache).catch(()=>[]))if(name.startsWith('chromium_headless_shell-'))candidates.push(join(cache,name,'chrome-headless-shell-mac-arm64/chrome-headless-shell'));
  return candidates.find(path=>path && existsSync(path));
}

// Actual browser geometry catches overflow that the DOM substitutes cannot.
// Set CHROME_BIN when Chromium is not installed in a standard location.
test('Touch composer focus stays readable and all settings tabs fit without horizontal scrolling', {timeout:60000}, async t=>{
  const executable=await findChrome();
  if(!executable)return t.skip('Chrome/Chromium unavailable; set CHROME_BIN to run layout verification.');
  const profile=await mkdtemp(join(tmpdir(),'nera-settings-layout-'));
  const server=createServer(async(req,res)=>{
    try {
      const path=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));
      if(!path.startsWith(root))throw Error('Outside fixture');
      let data=await readFile(path);
      if(path.endsWith('index.html'))data=Buffer.from(data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('class="app hidden"','class="app"'));
      res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':path.endsWith('.html')?'text/html':'application/octet-stream');
      res.end(data);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=spawn(executable,['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-pipe'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  let serial=0,buffer='',errors='';const pending=new Map();
  browser.stderr.on('data',data=>{errors=(errors+data).slice(-3000);});
  const rejectPending=error=>{for(const job of pending.values()){clearTimeout(job.timeout);job.reject(error);}pending.clear();};
  browser.on('error',rejectPending);
  browser.on('exit',()=>rejectPending(Error('Browser exited: '+errors)));
  browser.stdio[3].on('error',rejectPending);
  browser.stdio[4].on('data',data=>{
    buffer+=data;let end;
    while((end=buffer.indexOf('\0'))!==-1){
      const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      const job=pending.get(message.id);if(!job)continue;
      clearTimeout(job.timeout);pending.delete(message.id);
      if(message.error)job.reject(Error(JSON.stringify(message.error)));else job.resolve(message.result);
    }
  });
  const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++serial,timeout=setTimeout(()=>{pending.delete(id);reject(Error('Browser timeout: '+method+' '+errors));},10000);
    pending.set(id,{resolve,reject,timeout});
    browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  try {
    const {targetId}=await command('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
    const send=(method,params)=>command(method,params,sessionId);
    const evaluate=async(fn,...args)=>{
      const result=await send('Runtime.evaluate',{expression:`(${fn.toString()})(...${JSON.stringify(args)})`,awaitPromise:true,returnByValue:true});
      assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;
    };
    await send('Page.enable');
    await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    for(let i=0;i<100;i++){
      if(await evaluate(()=>document.getElementById('settings-tab') && document.readyState==='complete'))break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    await evaluate(async()=>{
      const get=id=>document.getElementById(id),long='VeryLongNameWithoutSpaces'.repeat(7);
      const {initIcons}=await import('/js/ui/icons.js');initIcons();
      get('settings-tab').classList.remove('hidden');
      for(const id of ['set-profiles','set-director-profile','set-narrator-profile','mem-updateProfileId','model-list'])get(id).append(new Option(long,long));
      get('model-picker').hidden=false;
      for(const id of ['thinking-options','advanced-options'])get(id).classList.remove('hidden');
      for(const item of document.querySelectorAll('[data-panel=memory] .hidden'))item.classList.remove('hidden');
      for(const detail of document.querySelectorAll('#settings-tab details'))detail.open=true;
      for(const id of ['set-endpoint','mem-semanticEndpoint'])get(id).value='https://example.test/'+long;
      for(const id of ['set-narrator-prompt','set-director-prompt','set-session-plan'])get(id).value=long.repeat(20);
      document.querySelector('[data-panel=prompts] h2').textContent='Prompts · '+long;
      get('account-email').textContent=long+'@example.test';get('app-version').textContent=long;
      for(const item of document.querySelectorAll('[data-panel=memory] [role=status],#mem-hints,#mem-update-status,#provider-status,#model-status'))item.textContent='Last update failed: https://example.test/'+long+'\n'+long;
      get('mem-blockRole').querySelector('option[value=user]').textContent='User (recommended): notes travel with your latest message';
      get('mem-blockRole').value='user';get('mem-reextract').textContent='Re-extract edited history from turn 123456789';
      for(const id of ['provider-selected','provider-list'])for(let i=0;i<8;i++){
        const row=document.createElement(id==='provider-selected'?'li':'div');row.className='provider-row';
        const label=document.createElement('span');label.textContent=long;row.append(label);
        for(const text of id==='provider-selected'?['↑','↓','Remove']:['Add']){const button=document.createElement('button');button.className='btn small';button.textContent=text;row.append(button);}get(id).append(row);
      }
      const {loadPetCatalog}=await import('/js/ui/pet-view.js');
      for(const pet of await loadPetCatalog()){
        const label=document.createElement('label');label.className='pet-choice';
        const checkbox=document.createElement('input');checkbox.type='checkbox';
        const preview=document.createElement('span');preview.className='pet-choice-preview';
        label.append(checkbox,preview,document.createTextNode(pet.name));get('set-pet-choices').append(label);
      }
    });
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    for(const [width,height] of [[320,568],[390,844],[390,330],[430,932],[932,430],[1024,768]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
      const composer=await evaluate(async()=>{
        const input=document.getElementById('chat-input');document.getElementById('settings-tab').classList.add('hidden');
        document.getElementById('welcome').hidden=true;
        const {createComposerSizer}=await import('/js/ui/composer-size.js');const resize=createComposerSizer({input:()=>input});
        const sizes=[],visibleSizes=[],widths=[],outside=[];
        const measure=()=>{
          const style=getComputedStyle(input),font=parseFloat(style.fontSize),scale=new DOMMatrixReadOnly(style.transform).a;
          sizes.push(font);visibleSizes.push(font*scale);
          widths.push(Math.abs(input.getBoundingClientRect().width-input.parentElement.clientWidth));
          for(const el of [input,document.getElementById('btn-send')]){const rect=el.getBoundingClientRect();if(rect.left<0 || rect.right>innerWidth+.5 || rect.top<0 || rect.bottom>innerHeight+.5)outside.push(el.id);}
        };
        for(const value of ['', 'A multiline message.\n'.repeat(12)]){
          input.blur();input.value=value;resize();await new Promise(requestAnimationFrame);measure();
          input.focus();resize();await new Promise(requestAnimationFrame);measure();
        }
        input.blur();document.getElementById('settings-tab').classList.remove('hidden');
        return {sizes,visibleSizes,widths,outside,touch:matchMedia('(hover: none) and (pointer: coarse)').matches,viewport:document.querySelector('meta[name=viewport]').content};
      });
      assert.equal(composer.touch,true,`${width}×${height} touch emulation`);
      assert.ok(composer.sizes.every(size=>size>=16),`${width}×${height} composer font sizes: ${composer.sizes}`);
      assert.ok(composer.visibleSizes.every(size=>size===14),`${width}×${height} visible composer text: ${composer.visibleSizes}`);
      assert.ok(composer.widths.every(difference=>difference<1),`${width}×${height} composer width: ${composer.widths}`);
      assert.deepEqual(composer.outside,[],`${width}×${height} composer and Send stay in view`);
      assert.doesNotMatch(composer.viewport,/user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=/i,'Manual zoom stays available');
    }
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    for(const [width,height] of [[320,568],[375,667],[390,844],[430,932],[667,375],[720,540],[721,540],[768,1024],[820,1180],[932,430],[1024,768],[1280,900]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<=720});
      for(const panel of ['categories','model','context','pets','prompts','story','memory','transfer','account']){
        const result=await evaluate(panel=>{
          const get=id=>document.getElementById(id),overlay=get('settings-tab'),content=get('settings-content');
          const global=['model','context','pets','prompts'].includes(panel),story=['story','memory'].includes(panel);
          overlay.classList.toggle('settings-detail-open',panel!=='categories');
          for(const section of overlay.querySelectorAll('.settings-panel'))section.classList.toggle('hidden',section.dataset.panel!==panel);
          get('settings-footer').classList.toggle('hidden',!global&&!story);get('btn-reset-settings').classList.toggle('hidden',!global);
          get('btn-save-settings').classList.toggle('hidden',!global);get('btn-save-session').classList.toggle('hidden',!story);
          const scroller=getComputedStyle(content).display==='none'?overlay.querySelector('.settings-rail'):content;
          scroller.scrollTop=scroller.scrollLeft=0;
          const name=el=>el.id||el.className||el.tagName;
          const overflowing=[overlay,...overlay.querySelectorAll('*')].filter(el=>el.getClientRects().length && el.clientWidth && !el.classList.contains('sr-only') && !['INPUT','TEXTAREA','OPTION','SELECT'].includes(el.tagName) && el.scrollWidth>el.clientWidth+1).map(name);
          const unreachable=[];
          for(const control of overlay.querySelectorAll('button,input,select,textarea,summary')){
            if(!control.getClientRects().length || control.disabled)continue;
            control.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
            const rect=control.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
            if(hit!==control && !control.contains(hit))unreachable.push(name(control));
          }
          scroller.scrollLeft=10000;const horizontalScroll=scroller.scrollLeft;scroller.scrollLeft=0;
          scroller.scrollTop=scroller.scrollHeight;const bottomReachable=scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-1;
          return {overflowing,unreachable,horizontalScroll,bottomReachable};
        },panel);
        assert.deepEqual(result,{overflowing:[],unreachable:[],horizontalScroll:0,bottomReachable:true},`${width}×${height} ${panel}`);
      }
    }
  }finally {
    browser.kill();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
