import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';
import {promptFetch,promptImportMeta} from './prompt-files.mjs';
const fixture=new URL('./fixtures/prompt-labels.json',import.meta.url);
async function samples({missingLines=false}={}){
 const context=vm.createContext({URL,fetch:promptFetch,console,structuredClone,TextEncoder,Date,Map,Set,AbortController,setTimeout,clearTimeout}),cache=new Map();
 async function load(path){if(cache.has(path))return cache.get(path);const pending=create(path);cache.set(path,pending);return pending;}
 async function create(path){const stubs=path==='messages.js'?{getMessages:async()=>[]}:path==='tokenizer.js'?{countTokens:async t=>t.length}:null;
 const module=stubs?new vm.SyntheticModule(Object.keys(stubs),function(){for(const [key,value]of Object.entries(stubs))this.setExport(key,value);},{context,identifier:path}):new vm.SourceTextModule(await readFile(new URL('../js/'+path,import.meta.url),'utf8'),{context,identifier:path,initializeImportMeta:promptImportMeta});
 await module.link((spec,parent)=>load(new URL(spec,'https://local/'+parent.identifier).pathname.slice(1)));return module;}
 async function use(path){const m=await load(path);if(m.status!=='evaluated')await m.evaluate();return m.namespace;}
 const l=await use('lore-lines.js'),p=await use('memory-prompts.js'),s=await use('lore-select.js'),t=await use('turns.js'),{normalizeMemory}=await use('memory-settings.js'),b=await use('context-builder.js');
 const history=[{id:'u1',order:1,narratorTurn:1,role:'user',content:'Mira arrives at the Inn.'},{id:'a1',order:2,narratorTurn:1,role:'assistant',content:'Mira waits.',scene:'Day 1 · night · Inn · present: Nera, Mira'}, {id:'u2',order:3,narratorTurn:2,role:'user',content:'Ask Mira about the letter.'},{id:'a2',order:4,narratorTurn:2,role:'assistant',content:'Mira promises to return.',scene:'Day 1 · night · Inn · present: Nera, Mira'}, {id:'summary',order:5,role:'summary',content:'**Last established situation (end of T1):** Mira at the Inn.',coveredRange:{toOrder:2},cutoffTurn:1},{id:'u3',order:6,narratorTurn:3,role:'user',content:'Wait for Mira.'}];
 const character=l.makeEntry('characters','Mira',{id:'mira',aliases:['Lady Mira'],alwaysLoad:true,createdFrom:'user'});character.sections.status.text='Waiting at the Inn.';character.sections.bond.text='Protective of Nera.';character.sections.status.lines=[{id:'line',text:"Promised $' $& $$ to return.",turn:2,when:'Day 1',by:'import',at:2,src:4}];
 const location=l.makeEntry('locations','Inn',{id:'inn',alwaysLoad:true});location.sections.description.text='An old inn.';
 const thread=l.makeEntry('events','Letter',{id:'letter',kind:'thread'});thread.sections.text.text='Find the letter.';
 const timeline=l.makeEntry('events','Timeline',{id:'timeline',kind:'timeline'});timeline.sections.text.text='Earlier events.';timeline.sections.text.lines=[{id:'event',text:'Mira arrived.',turn:1,when:'Day 1',by:'import',src:2,at:1}];
 const entries=[character,location,thread,timeline];
 if(missingLines)for(const entry of entries)for(const section of Object.values(entry.sections))if(!section.lines.length)delete section.lines;
 const mem=normalizeMemory({protagonist:'Nera',memoryBlock:true,lorebooks:true,scene:true,batchTurns:2,lagTurns:0,updateMaxTokens:256}),settings={narratorSystemPrompt:'Narrate.',maxContextTokens:120000,maxResponseTokens:8192};
 const range=t.dueRange(history,{extractedThroughOrder:0},mem),extraction=await p.buildExtractionMessages({settings,mem,entries,messages:history,range,count:async text=>text.length});
 const characters=await s.fitBook([{entry:character}],5000,async text=>text.length,{protagonist:'Nera'}),locations=await s.fitBook([{entry:location}],5000,async text=>text.length);
 const memory=s.renderMemoryBlock({scene:{raw:'Day 1 · night · Inn'},characters,locations}),staleMemory=s.renderMemoryBlock({scene:{raw:'Day 1 · night · Inn'},staleScene:true,characters,locations});
 const events=s.renderEventsBlock(await s.fitBook([{entry:thread},{entry:timeline}],5000,async text=>text.length,{events:true}),{provenance:true});
 const narration=await b.buildContextForRequest({id:'story',memory:mem,activeSummaryMessageId:'summary',breakpointOrder:2},settings,{messages:history,loreEntries:entries,requireLatestUser:true});
 return {extraction:extraction.messages,reorganize:p.buildReorganizeMessages({settings,mem,entries,instruction:'Keep exact names.'}),memory,staleMemory,events,narration:narration.apiMessages};
}
if(process.argv.includes('--capture'))await writeFile(fixture,JSON.stringify(await samples(),null,2)+'\n');
else {
 test('Q2 prompt labels preserve extraction, reorganize, narrator lore and full request bytes',async()=>{assert.deepEqual(JSON.parse(JSON.stringify(await samples())),JSON.parse(await readFile(fixture,'utf8')));});
 test('Q5 missing lore line arrays remain safe in extraction, reorganize and narrator rendering',async()=>{assert.deepEqual(JSON.parse(JSON.stringify(await samples({missingLines:true}))),JSON.parse(await readFile(fixture,'utf8')));});
}
