import { readFile, writeFile } from 'node:fs/promises';
import { appHarness } from '../tests/app-harness.mjs';

const root = new URL('../',import.meta.url);
const read = file => readFile(new URL(file,root),'utf8');
const action = process.argv[2];
const outputPrefix = process.argv.find(x => x.startsWith('--out-prefix='))?.slice(13) ?? action;
if (!['progression','ooc'].includes(action)) throw new Error('Choose progression or ooc.');
const original = JSON.parse(await read('investigate/LLM_request.txt'));
const records = (await read('investigate/chat-history.jsonl')).trim().split(/\r?\n/).map(x => JSON.parse(x));
const { session,lore } = records[0].nera;
const opening = { ...records[1].nera.message,content:records[1].mes };
const raw = 'date: 18 September 731 · time: unknown · place: West Reception Room · present: Nera Veyrath, Isolde Veyless, Elise Fen, Liora Fen, Bastian Krail';
const assistant = { id:'fixture-opening',order:2,role:'assistant',revision:0,narratorTurn:1,
  content:'Bastian Krail waits beside the unsigned punishment order. Isolde Veyless stands beside you. Elise Fen and Liora Fen remain in the west reception room. Magerrett Veyrath listens outside; Taigar Veyrath is farther down the corridor. Krail taps the empty signature line. "Your decision, my lord."',
  scene:raw,planThread:'P1: await Nera’s decision.',ooc:false };
const progression = { id:'fixture-progression-user',order:3,role:'user',revision:0,
  content:'<ad>Continue the hearing. Have Bastian Krail leave the room; do not move Nera or the other people.</ad>' };
const history = [opening,assistant,progression];
if (action === 'ooc') {
  const calls = JSON.parse(await read('investigate/live/calls.json'));
  const call = calls.findLast(x => x.action==='progression' && x.status==='complete');
  if (!call) throw new Error('Complete and analyze the progression call before preparing OOC.');
  const reply = JSON.parse(await read(`investigate/live/${call.attempt}-progression-parsed.json`));
  // This mirrors the app, including its currently reproduced AD/OOC classification defect.
  history.push({ id:'fixture-progression-assistant',order:4,role:'assistant',revision:0,narratorTurn:2,
    content:(await appHarness()('plan-parser.js')).stripPlan(reply.content),
    scene:reply.appSavedScene,planThread:reply.planThread,ooc:reply.appClassifiesOoc });
  history.push({ id:'fixture-ooc-user',order:5,role:'user',revision:0,
    content:'<ad>Who is physically present in the west reception room right now? Answer OOC without advancing events.</ad>' });
}
const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async () => { throw new Error('Unexpected storage read'); } },
  'tokenizer.js':{ countTokens:async text => Math.ceil(new TextEncoder().encode(text).length/4) } } });
const { buildContextForRequest } = await use('context-builder.js');
const settings = { narratorSystemPrompt:(await use('system-prompts.js')).prompts.narrator,
  maxContextTokens:120000,maxResponseTokens:original.max_tokens,keepRecentMessagesAfterSummary:10 };
const built = await buildContextForRequest(session,settings,{ messages:history,loreEntries:lore,requireLatestUser:true });
const payload = { ...original,messages:built.apiMessages };
await writeFile(new URL('investigate/'+outputPrefix+'-request.json',root),JSON.stringify(payload,null,2)+'\n');
await writeFile(new URL('investigate/'+outputPrefix+'-fixture.json',root),JSON.stringify({
  note:'Disposable synthetic opening; no original assistant actions adopted as canon. Token fitting uses UTF-8 bytes/4, not the model tokenizer.',
  history,report:built.report,expected:{ place:'West Reception Room',date:'18 September 731',time:null,
    present:['Nera Veyrath','Isolde Veyless','Elise Fen','Liora Fen'],outside:['Magerrett Veyrath','Taigar Veyrath','Bastian Krail'] } },null,2)+'\n');
console.log(JSON.stringify({ scenario:action,loaded:built.report.loaded.filter(x => ['characters','locations'].includes(x.book)).map(x => ({ name:x.name,reason:x.reason })),warnings:built.report.warnings }));
