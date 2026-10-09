import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';

const root=process.env.F20_PROMPT_ROOT;
const readPrompt=file=>readFile(root ? `${root}/${file}` : new URL('../system prompts/'+file,import.meta.url),'utf8');
test('F20 default summary prompt matches the approved narrative-layer text within its word budget',async()=>{
  const plan=await readFile(new URL('../RELEASE.md',import.meta.url),'utf8');
  const approved=plan.split('**Text of the new `system prompts/summarizer.md`**')[1].split('```markdown\n')[1].split('\n```')[0];
  const actual=(await readPrompt('summarizer.md')).trim();
  assert.equal(actual,approved);
  assert.ok(actual.split(/\s+/).length<=1470);
  const directive=await readPrompt('summary-output.md');
  assert.match(directive,/carry forward the previous summary's still-relevant story, voice, relationship, knowledge, and promise information/);
  assert.match(directive,/\{\{MAX_OUTPUT_TOKENS\}\}/);
});
test('F20 immediately preceding summary default migrates, while customized summaries stay unchanged',async()=>{
  const use=appHarness({globals:{crypto:webcrypto,fetch:async(url,options)=>{
    const file=decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    if(root && ['summarizer.md','summary-output.md','legacy-prompt-default-hashes.md'].includes(file))return {ok:true,text:()=>readPrompt(file)};
    return promptFetch(url,options);
  }},stubs:{'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc:()=>{},getDocFromServer:()=>{},setDoc:()=>{},onSnapshot:()=>{}},'db.js':{db:{}},'auth.js':{currentUid:()=> 'owner'},'state.js':{state:{}}}});
  const settings=await use('settings.js');
  // This is the exact outgoing default whose hash the release adds to migrations.
  const old=await readFile(new URL('./fixtures/summary-before-f20.md',import.meta.url),'utf8');
  assert.ok((await readPrompt('legacy-prompt-default-hashes.md')).split('\n').includes('summarizerSystemPrompt 039940653b9452e1975a00787e0ebfe887b9fecb409a730b380c498d67256609'));
  assert.equal((await settings.mergeDefaults({summarizerSystemPrompt:old.trim()})).summarizerSystemPrompt,settings.DEFAULT_SETTINGS.summarizerSystemPrompt);
  const custom=old.trim()+'\nMy custom story requirements.';
  assert.equal((await settings.mergeDefaults({summarizerSystemPrompt:custom})).summarizerSystemPrompt,custom);
});
