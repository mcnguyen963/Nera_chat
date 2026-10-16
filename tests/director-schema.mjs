import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {inputBounds} from './tools/lorebook-eval-core.mjs';
const plain=x=>JSON.parse(JSON.stringify(x)),count=async t=>Math.ceil(t.length/4);
async function fixture(){
 const use=appHarness({stubs:{'tokenizer.js':{countTokens:count},'messages.js':{getMessages:async()=>[]}}}),l=await use('lore-lines.js'),schema=await use('director-schema.js'),state=await use('director-state.js'),context=await use('director-context.js');
 const entries=['Nera','Liora','Lysia'].map((name,i)=>{const e=l.makeEntry('characters',name);e.id='person-'+i;e.sections.notes.text=name+' source';return e;});
 const hidden=l.makeEntry('facts','Unselected fact');hidden.id='hidden';entries.push(hidden);
 const before={version:2,scene:{date:'21/10/738',time:'15:00',location:'Yard',present:['Nera','Liora']},event:null,decisions:[],threads:[],commitments:[]};
 const settings={directorProfileId:'d',profiles:[{id:'d',endpoint:'https://openrouter.ai/api/v1/chat/completions',modelId:'test',apiKey:'offline'}],directorMaxInputTokens:20000,directorMaxOutputTokens:8192,directorRecentTurns:5,directorFocusLimit:5};
 const contract={version:1,action:'narrate',transition:'attempted',objective:'Seek Lysia; Liora can answer without a new player confirmation.',stopCondition:'Before the next player decision.',memoryIds:[],requiredMemoryIds:[],focusCharacterIds:['person-1'],encounterCharacterIds:['person-2'],updates:{}};
 return {use,l,schema,state,context,settings,entries,before,contract};
}
test('request-specific strict schema enumerates only offered IDs and encodes complete ledger operations',async()=>{
 const h=await fixture(),format=h.schema.directorResponseFormat({endpoint:h.settings.profiles[0].endpoint},{entries:h.entries,before:h.before,offeredIds:['person-0','person-1','person-2'],protagonist:'Nera',focusLimit:5});
 assert.equal(format.type,'json_schema');assert.equal(format.json_schema.strict,true);
 const s=format.json_schema.schema;assert.deepEqual(plain(s.$defs.memoryId.enum),['person-0','person-1','person-2']);assert.deepEqual(plain(s.$defs.characterId.enum),['person-1','person-2']);assert.ok(!JSON.stringify(format).includes('hidden'));
 assert.ok(s.required.includes('encounterCharacterIds'));assert.equal(s.additionalProperties,false);assert.match(s.properties.focusCharacterIds.description,/At most 5/);
 const full=s.properties.updates.anyOf[1];assert.deepEqual(plain(full.required),['scene','event','decisions','threads','commitments']);assert.deepEqual(plain(full.properties.commitments.required),['upsert','close']);assert.match(full.properties.commitments.properties.close.description,/Must be empty/);
 assert.deepEqual(plain(s.$defs.ledgerItem.required),['id','text','status','trigger','source','threadMeta']);
 const local=h.schema.directorResponseFormat({endpoint:'http://local/v1/chat/completions'},{entries:h.entries,before:h.before,offeredIds:[]});assert.deepEqual(plain(local),{type:'json_object'});
});
test('native-compatible empty lore schemas avoid unsupported constraints; local checks reject references',async()=>{
 const h=await fixture(),s=h.schema.directorResponseFormat({endpoint:h.settings.profiles[0].endpoint},{entries:[],before:h.before,offeredIds:[]}).json_schema.schema;
 for(const key of ['memoryIds','requiredMemoryIds','focusCharacterIds','encounterCharacterIds'])assert.match(s.properties[key].description,/Must be empty/);
 function walk(value){if(!value||typeof value!=='object')return;for(const key of ['minimum','maximum','maxItems','minLength','maxLength'])assert.equal(value[key],undefined);if(value.enum)assert.ok(value.enum.length);if(value.$ref)assert.ok(s.$defs[value.$ref.split('/').at(-1)]);for(const v of Object.values(value))walk(v);}walk(s);
 assert.throws(()=>h.state.parseDirectorContract(JSON.stringify({...h.contract,memoryIds:['anything']}),h.before,[]),/unknown memory/);
});
test('absent encounter targets load lore without inventing attendance and become focus only after arrival',async()=>{
 const h=await fixture(),turn=h.state.parseDirectorContract(JSON.stringify(h.contract),h.before,h.entries,{protagonist:'Nera',allowedMemoryIds:['person-0','person-1','person-2']});
 assert.deepEqual(plain(turn.after.scene.present),['Nera','Liora']);assert.ok(turn.contract.memoryIds.includes('person-2'));assert.deepEqual(plain(turn.contract.focusCharacterIds),['person-1']);
 const arrived=h.state.parseDirectorContract(JSON.stringify({...h.contract,transition:'completed',focusCharacterIds:['person-2'],updates:{scene:{location:'Dispensary bench',present:['Nera','Lysia']}}}),h.before,h.entries,{protagonist:'Nera'});assert.deepEqual(plain(arrived.after.scene.present),['Nera','Lysia']);
 for(const bad of [{memoryIds:['invented-id']},{memoryIds:['hidden']},{encounterCharacterIds:['hidden']},{encounterCharacterIds:['person-0']},{focusCharacterIds:['person-2']}])assert.throws(()=>h.state.parseDirectorContract(JSON.stringify({...h.contract,...bad}),h.before,h.entries,{protagonist:'Nera',allowedMemoryIds:['person-0','person-1','person-2']}),/unknown memory|encounterCharacterIds|focusCharacterIds/);
 const old={...h.contract};delete old.encounterCharacterIds;delete old.focusCharacterIds;assert.doesNotThrow(()=>h.state.parseDirectorContract(JSON.stringify(old),h.before,h.entries));
});
test('schema overhead participates in input budget and conservative paid-call bounds',async()=>{
 const h=await fixture(),session={id:'s',memory:{protagonist:'Nera'}},messages=[{id:'u',role:'user',order:1,content:'I wait.'}];
 const built=await h.context.buildDirectorContext(session,h.settings,messages,[],h.before,{count});assert.ok(built.report.responseSchemaTokens>0);assert.equal(built.responseFormat.type,'json_schema');
 const messageOnly=built.usedTokens-built.report.responseSchemaTokens;assert.ok(messageOnly<built.usedTokens-1);
 await assert.rejects(h.context.buildDirectorContext(session,{...h.settings,directorMaxInputTokens:built.usedTokens-1},messages,[],h.before,{count}),/input budget/);
 const body={messages:built.apiMessages,response_format:built.responseFormat},without=inputBounds({messages:body.messages},0).inputBound,withSchema=inputBounds(body,0).inputBound;assert.equal(withSchema-without,new TextEncoder().encode(JSON.stringify(body.response_format)).length);
 const options=h.context.directorOutputOptions({endpoint:h.settings.profiles[0].endpoint},built);assert.equal(options.responseFormat.type,'json_schema');assert.equal(options.provider.require_parameters,true);
});
test('request construction preserves explicitly sought NPC control lore when schema forces history trimming',async()=>{
 const h=await fixture(),history=[];for(let i=0;i<5;i++)history.push({id:'u'+i,role:'user',order:2*i+1,content:'Older details. '.repeat(120)},{id:'a'+i,role:'assistant',order:2*i+2,content:'Older narrative. '.repeat(120)});history.push({id:'latest',order:11,role:'user',content:'I visit Lysia.'});
 h.entries[2].sections.notes.text='Lysia is available at the dispensary bench. '.repeat(20);
 const session={id:'s',memory:{protagonist:'Nera'}},large=await h.context.buildDirectorContext(session,h.settings,history,h.entries,h.before,{count});
 const small=await h.context.buildDirectorContext(session,{...h.settings,directorMaxInputTokens:large.usedTokens-700},history,h.entries,h.before,{count});
 assert.ok(small.report.controlMemoryIds.includes('person-2'));assert.ok(small.report.recentMessages.length<large.report.recentMessages.length);assert.ok(small.usedTokens<=large.usedTokens-700);
});
test('unknown ID from the live failure is rejected before saving with no automatic repair',async()=>{
 let calls=0,saves=0;const use=appHarness({stubs:{'tokenizer.js':{countTokens:count},'director-store.js':{getDirectorTurn:async()=>null,savePendingDirectorTurn:async()=>{saves++;}},'llm-client.js':{chatCompletion:async options=>{calls++;assert.equal(options.responseFormat.type,'json_schema');return {finishReason:'stop',content:JSON.stringify({version:1,action:'narrate',transition:'attempted',objective:'Walk toward the dispensary.',stopCondition:'Before the next player choice.',memoryIds:['lore_mv45v9hnvm3pg0pc'],requiredMemoryIds:[],focusCharacterIds:[],encounterCharacterIds:[],updates:{}})};}}}});
 const h=await fixture(),api=await use('director-turn.js');await assert.rejects(api.prepareDirectorTurn({id:'s',memory:{protagonist:'Nera'},directorState:h.before},h.settings,[{id:'u',order:1,role:'user',content:'Visit Lysia.'}],h.entries),/unknown memory cards/);assert.equal(calls,1);assert.equal(saves,0);
});
