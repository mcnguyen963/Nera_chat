import {appHarness} from '../app-harness.mjs';
import {promptFetch} from '../prompt-files.mjs';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
// Run with Node's VM modules enabled and Ollama listening on localhost:11434.
// This is an exploratory benchmark, not an implementation of lorebook RAG.
const use=appHarness(), {makeEntry}=await use('lore-lines.js'),{selectEntries}=await use('lore-select.js'),{normalizeMemory}=await use('memory-settings.js');
// Invented examples. None of the cards or queries come from the user's story.
const defs=[
 ['characters','Mara Voss',['the apothecary'],'A village healer who cures poison and prepares antidotes from rare herbs.'],
 ['characters','Corin Vale',['the ferryman'],'An old boatman who carries travellers across the river in his wooden ferry.'],
 ['characters','Lysa Thorn',['the locksmith'],'A craftswoman who opens locked doors and makes replacement keys.'],
 ['characters','Darian Holt',['the royal archivist'],'A scholar who safeguards royal documents and researches forgotten laws in the palace archives.'],
 ['characters','Nessa Reed',['the stablemaster'],'She tends horses at the city stables and rents mounts to travellers.'],
 ['characters','Tarin Moss',['the blacksmith'],'A metalworker who repairs damaged swords and forges armour.'],
 ['characters','Selene Frost',['the seer'],'A fortune teller who claims to see future events in dreams.'],
 ['characters','Bram Alder',['the baker'],'A baker who sells bread and cakes in the market square.'],
 ['characters','Vera Ash',['the jailer'],'A prison guard who holds the keys to the dungeon cells.'],
 ['characters','Ivo Bell',['the smuggler'],'A criminal who secretly transports forbidden goods across the border.'],
 ['locations','Moonwell Sanctuary',['the healing shrine'],'A peaceful temple where wounded people recover and clerics treat illnesses.'],
 ['locations','Redstone Keep',['the old fortress'],'A fortified castle on a hill, once used by the king as a military stronghold.'],
 ['locations','Whispering Grove',['the enchanted forest'],'A dense woodland where ancient trees whisper and magical creatures hide.'],
 ['locations','Harbor of Mists',['the foggy port'],'A coastal dock where ships arrive and sailors trade cargo.'],
 ['locations','Crystal Vault',['the treasure chamber'],'An underground room containing royal gold, jewels, and other valuables.'],
 ['locations','Sunspire Observatory',['the star tower'],'A tall tower with telescopes for studying stars and planets at night.'],
 ['locations','Ashen Library',['the forbidden archive'],'A restricted library of dangerous spellbooks and secret magical manuscripts.'],
 ['locations','Sapphire Bazaar',['the gem market'],'A busy marketplace where merchants sell gemstones and precious stones.'],
];
const cases=[
 ['exact','Ask Mara Voss about a cure.',0],['exact','I travel to Redstone Keep.',11],['exact','Find Darian Holt.',3],['exact','Take me to Sunspire Observatory.',15],
 ['alias','Visit the apothecary.',0],['alias','Find the ferryman.',1],['alias','Enter the forbidden archive.',16],['alias','Walk to the gem market.',17],
 ['paraphrase','Who can make an antidote for a poisoned traveller?',0],['paraphrase','I need someone to take me over the river by boat.',1],['paraphrase','Find a craftsperson who can open a door without a key.',2],['paraphrase','Who researches the kingdom’s old legislation?',3],['paraphrase','Where can I hire a horse?',4],['paraphrase','Who can mend my broken blade?',5],['paraphrase','Where should the injured go to be treated by clerics?',10],['paraphrase','Where can I observe planets through a telescope?',15],['paraphrase','Where are the king’s jewels stored underground?',14],['paraphrase','I need to buy rubies and diamonds from traders.',17],
 ['distractor','Who holds the keys to the prison cells?',8],['distractor','Where are dangerous spellbooks kept?',16],['distractor','Who tells fortunes from dreams?',6],['distractor','Find the person transporting illegal cargo across the border.',9],
 ['hard','Mara Voss is hungry. Find the person who sells fresh bread.',7],
 ['hard','The locksmith is not available. Who keeps prisoners confined?',8],
 ['hard','I am not looking for a harbor. Find the place where magical books are restricted.',16],
 ['hard','I need someone who does not predict the future but can mend a sword.',5],
 ['no-answer','Where can I purchase a flying carpet?',null],['no-answer','Who is the emperor of the distant northern moon?',null],['no-answer','Find the machine that travels backwards in time.',null],
 ['no-answer','Who is the healer that resurrects dead people?',null],['no-answer','Where is the library of books on underwater cooking?',null]
];
const entries=defs.map(([book,name,aliases,desc],i)=>{const e=makeEntry(book,name,{id:'synthetic-'+i,aliases});e.sections[book==='characters'?'notes':'description'].text=desc;return e});
const mem=normalizeMemory({lorebooks:true,books:{characters:{on:true,maxCards:3},locations:{on:true,maxCards:3}}});
async function embed(input){const response=await fetch('http://127.0.0.1:11434/api/embed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'qwen3-embedding:0.6b',input}),signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('Ollama HTTP '+response.status);const data=await response.json();if(data.embeddings?.length!==input.length)throw Error('Incomplete Ollama vectors');return data.embeddings;}
function cosine(a,b){let ab=0,aa=0,bb=0;for(let i=0;i<a.length;i++){ab+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return ab/Math.sqrt(aa*bb)}
const t0=performance.now(), docs=await embed(defs.map(([book,name,aliases,description])=>`${book}: ${name}. Also known as ${aliases.join(', ')}. ${description}`)), t1=performance.now(), queries=await embed(cases.map(c=>c[1])), t2=performance.now();
const singleQueryMs=[];
for(let i=0;i<3;i++){const start=performance.now();await embed([cases[8][1]]);singleQueryMs.push(Math.round(performance.now()-start));}
const outcomes=cases.map(([type,query,target],i)=>{const start=performance.now(),result=selectEntries(entries,mem,query,null,'');const selectorMs=performance.now()-start;const selected=[...result.selected.characters,...result.selected.locations].map(x=>x.entry.id);const ranked=docs.map((v,id)=>({id,score:cosine(v,queries[i])})).sort((a,b)=>b.score-a.score);return {type,query,target:target==null?null:defs[target][1],baselineHit:target==null?selected.length>0:selected.includes('synthetic-'+target),baselineCount:selected.length,embeddingRank:target==null?null:ranked.findIndex(r=>r.id===target)+1,embeddingTop:defs[ranked[0].id][1],topScore:+ranked[0].score.toFixed(3),selectorMs:+selectorMs.toFixed(2)};});
const groups={};for(const type of [...new Set(cases.map(c=>c[0]))]){const a=outcomes.filter(r=>r.type===type),answer=a.filter(r=>r.target);groups[type]={cases:a.length,baselineHit:answer.filter(r=>r.baselineHit).length,embeddingTop1:answer.filter(r=>r.embeddingRank===1).length,embeddingTop3:answer.filter(r=>r.embeddingRank<=3).length,...(type==='no-answer'?{baselineReturned:a.filter(r=>r.baselineCount>0).length,embeddingReturned:a.length}: {})};}
// Inspect actual request builders, without invoking a language model or saving data.
const count=async text=>Math.ceil(text.length/4);
const requestUse=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected read')}},'tokenizer.js':{countTokens:count}}});
const builder=await requestUse('context-builder.js'),prompts=await requestUse('memory-prompts.js'),turns=await requestUse('turns.js');
const requestSettings={narratorSystemPrompt:'Narrate.',maxContextTokens:60000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:10};
const marker=defs[0][3],single=[entries[0]],requestMem=normalizeMemory({lorebooks:true,memoryBlock:true,loreLookbackMessages:0});
async function inspect(query){
  const messages=[{id:'u',order:1,role:'user',content:query},{id:'a',order:2,role:'assistant',content:'The conversation continues.'}];
  const built=await builder.buildContextForRequest({id:'synthetic',memory:requestMem},requestSettings,{messages,loreEntries:single,includeInspection:true});
  const range={assistants:turns.computeTurns(messages).assistants,fromTurn:1,toTurn:1,endOrder:2,messages};
  const extraction=await prompts.buildExtractionMessages({settings:requestSettings,mem:requestMem,entries:single,messages,range,count});
  return {narrationContainsCardText:built.apiMessages.some(m=>m.content.includes(marker)),memoryUpdateContainsCardText:extraction.messages.some(m=>m.content.includes(marker))};
}
const injection={named:await inspect('Ask Mara Voss for help.'),indirect:await inspect('Who can make an antidote for a poisoned traveller?')};
assert.deepEqual(injection.named,{narrationContainsCardText:true,memoryUpdateContainsCardText:true});
assert.deepEqual(injection.indirect,{narrationContainsCardText:false,memoryUpdateContainsCardText:false});
// Evaluate the actual optional semantic component, including its conservative gate.
const semanticUse=appHarness({globals:{fetch:(url,options)=>String(url).startsWith('http:') ? fetch(url,options) : promptFetch(url,options)}});
const records=new Map(),storage={load:async key=>records.get(key),save:async(value,check)=>{check();records.set(value.key,value);return true;}};
const semantic=(await semanticUse('lore-semantic.js')).createLoreSemantic({storage});
const semanticMem={...mem,semanticLore:true},scope={owner:'synthetic',sid:'synthetic',mem:semanticMem,entries};
await semantic.index(scope);
for(let i=0;i<cases.length;i++){const result=await semantic.search({...scope,query:cases[i][1]});outcomes[i].gatedIds=result.ids.map(id=>defs[Number(id.slice('synthetic-'.length))][1]);outcomes[i].gatedHit=cases[i][2]==null ? result.ids.length>0 : result.ids.includes('synthetic-'+cases[i][2]);}
for(const type of Object.keys(groups)){const rows=outcomes.filter(r=>r.type===type);groups[type].gatedHit=rows.filter(r=>r.target && r.gatedHit).length;if(type==='no-answer')groups[type].gatedReturned=rows.filter(r=>r.gatedHit).length;}
console.log(JSON.stringify({method:'Real current lorebook selector vs experimental cosine similarity over synthetic full-card text; no scenes or recent messages; raw embedding ranking has no threshold; gated results use the proposed component; relevant card labels manually specified.',model:'qwen3-embedding:0.6b',cards:defs.length,dimensions:docs[0].length,embeddingDocumentBatchMs:Math.round(t1-t0),embeddingQueryBatchMs:Math.round(t2-t1),singleQueryMs,groups,injection,outcomes},null,2));
