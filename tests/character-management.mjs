import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
test('management defaults protect constraints, future conditions and author content in existing formats',async()=>{
 const use=appHarness(),p=await use('memory-prompts.js'),l=await use('lore-lines.js'),m=await use('memory-settings.js'),t=await use('turns.js');
 const e=l.makeEntry('characters','Isolde'),author='Obedience is not affection; her loyalties are her own.';e.sections.bond.text=author;
 e.sections.bond.lines=[{id:'mine',text:'AUTHOR_WRITTEN_NOTE remains unchanged.',by:'user',turn:1},{id:'scribe',text:'If the council invites her next winter, she may attend; she has not enrolled.',by:'auto',turn:1,when:'Day 1',src:2,evidence:[{id:'a',revision:0,order:2}]}];
 const messages=[{id:'u',role:'user',order:1,content:'Isolde asks the council about an invitation.'},{id:'a',role:'assistant',order:2,content:'The council might invite her next winter.'}],mem=m.normalizeMemory({lorebooks:true,batchTurns:2,lagTurns:0}),settings={maxContextTokens:20000},before=JSON.stringify(e);
 const range=t.dueRange(messages,{extractedThroughOrder:0},mem,{manual:true});const extraction=await p.buildExtractionMessages({settings,mem,entries:[e],messages,range,count:async t=>t.length});const reorganize=p.buildReorganizeMessages({settings,mem,entries:[e]});
 for(const text of [extraction.messages[0].content,reorganize[0].content,p.LOREBOOK_TEMPLATE_MD,p.LOREBOOK_TEMPLATE_JSON]) {assert.match(text,/knowledge boundaries/);assert.match(text,/conditions|conditional/);assert.match(text,/400 characters/);assert.match(text,/Never generate or approve core-reference metadata/);}
 assert.match(extraction.messages[0].content,/Never write personality notes/);assert.match(extraction.messages[0].content,/T<number> \[char\] NAME \| SECTION: note/);
 assert.match(reorganize[0].content,/never repeat or change the author's text/);assert.match(reorganize[0].content,/Merge only equivalent claims/);assert.match(reorganize[1].content,/AUTHOR_WRITTEN_NOTE remains unchanged/);assert.ok(reorganize[1].content.includes(author));assert.ok(reorganize[1].content.includes(e.sections.bond.lines[1].text));assert.equal(JSON.stringify(e),before);
 const parsed=l.parseMemoryLines('T1 [char] Isolde | bond: If invited next winter, she may attend; she has not enrolled.',{reorganize:true,allowPersonality:true,entries:[e],mem,protagonist:'Nera'});assert.equal(parsed.ops.length,1);assert.equal(parsed.ops[0].text,'If invited next winter, she may attend; she has not enrolled.');
 const custom={...settings,memoryExtractionPrompt:'MY EXTRACTION PROMPT',memoryReorganizePrompt:'MY REORGANIZE PROMPT'};
 assert.ok((await p.buildExtractionMessages({settings:custom,mem,entries:[e],messages,range,count:async t=>t.length})).messages[0].content.startsWith('MY EXTRACTION PROMPT\n'));assert.ok(p.buildReorganizeMessages({settings:custom,mem,entries:[e]})[0].content.startsWith('MY REORGANIZE PROMPT\n'));
});
