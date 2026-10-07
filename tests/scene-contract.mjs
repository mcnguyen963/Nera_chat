import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const labeled = 'date: 18 September 731 · time: unknown · place: West Reception Room · present: Nera Veyrath, Isolde Veyless, Elise Fen, Liora Fen, Bastian Krail';

test('narrative author directives can update scene state while explicit OOC and questions preserve it',async () => {
  const use = appHarness(), { isPureOoc } = await use('scene.js');
  for (const text of ['<ad>Continue the hearing. Have Krail leave the room.</ad>',
    '<ad>Have Bastian Krail leave the room.</ad>','<ad>The door opens and Magerrett enters.</ad>',
    '<ad>Summarize what happened, then continue the hearing.</ad>',
    '<ad>Answer OOC, then continue the hearing.</ad>',
    '<ad>What does Krail think?</ad> I ask him to leave.']) assert.equal(isPureOoc(text),false);
  for (const text of ['<ad>Who is physically present?</ad>','<ad>What does Mira believe?</ad>',
    '<ad>Can you summarize the hearing?</ad>','<ad>Summarize the scene.</ad>',
    '<ad>Answer OOC without advancing events.</ad>','<ooc>Explain the scene.</ooc>',
    'OOC: Who is present?','[OOC] Who is present?']) assert.equal(isPureOoc(text),true);
});

test('the current scene contract parses values without retaining field labels or unknown attendees',async () => {
  const use = appHarness(), scene = await use('scene.js');
  const parsed = scene.parseScene(labeled);
  assert.equal(parsed.when,'18 September 731');
  assert.equal(parsed.time,null);
  assert.equal(parsed.place,'West Reception Room');
  assert.equal(parsed.present.length,5);
  const unknown = scene.parseScene('date: unknown · time: unknown · place: unknown · present: unknown');
  assert.deepEqual(plain([unknown.when,unknown.time,unknown.place,unknown.present]),[null,null,null,[]]);
  assert.equal(scene.parseScene(labeled.replace('West Reception Room','West Wing - Reception Room, Upstairs')).place,'West Wing - Reception Room, Upstairs');
});

test('scene extraction preserves a long attendance list and rejects oversized output without saving partial names',async () => {
  const use = appHarness(), scene = await use('scene.js');
  const names = Array.from({ length:25 },(_,i) => `Established Character ${i}`);
  const raw = 'date: Day 2 · time: night · place: Inn · present: '+names.join(', ');
  assert.ok(raw.length>300);
  assert.equal(scene.extractScene(`<scene>${raw}</scene>`),raw);
  assert.deepEqual(plain(scene.parseScene(raw).present),names);
  assert.equal(scene.extractScene(`<scene>${'x'.repeat(scene.MAX_SCENE_LENGTH+1)}</scene>`),null);
  assert.equal(scene.extractScene('Text\n<scene>unfinished'),null);
  assert.equal(scene.extractScene('<!--HIDDEN-->[Scene: Inn]<!--/HIDDEN-->'),null);
});


test('present characters and current place precede unrelated mentions under card limits',async () => {
  const use = appHarness(), { makeEntry } = await use('lore-lines.js');
  const { normalizeMemory } = await use('memory-settings.js'), select = await use('lore-select.js');
  const distant = makeEntry('characters','Absent Person'), present = makeEntry('characters','Present Person');
  const elsewhere = makeEntry('locations','Academy'), here = makeEntry('locations','Inn');
  const result = select.selectEntries([distant,present,elsewhere,here],normalizeMemory({ lorebooks:true,
    books:{ characters:{ maxCards:1 },locations:{ maxCards:1 } } }),
  'I remember Absent Person at the Academy.',{ present:['Present Person'],place:'Inn' });
  assert.deepEqual(plain(result.selected.characters.map(x => x.entry.id)),[present.id]);
  assert.deepEqual(plain(result.selected.locations.map(x => x.entry.id)),[here.id]);
  assert.ok(result.skipped.some(x => x.entryId===distant.id && x.reason.startsWith('card limit')));
});

test('ambiguous scene aliases do not load an arbitrary person and exact canonical headings win',async () => {
  const use = appHarness(), { makeEntry } = await use('lore-lines.js'), select = await use('lore-select.js');
  const a = makeEntry('characters','Mira Ash',{ aliases:['Mira'] }), b = makeEntry('characters','Mira Vale',{ aliases:['Mira'] });
  const result = select.resolveScene({ present:['Mira','New Guard'] },select.buildLoreIndex([a,b]));
  assert.deepEqual(plain(result.characters),[]);
  assert.deepEqual(plain(result.ambiguous),['Mira']);
  assert.deepEqual(plain(result.unmatched),['New Guard']);
  const exact = makeEntry('characters','Mira');
  assert.deepEqual(plain(select.resolveScene({ present:['Mira'] },select.buildLoreIndex([a,b,exact])).characters),[exact.id]);
});

test('a saved labeled scene round trip feeds the next request and missing scenes remain visible as warnings',async () => {
  const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async () => { throw new Error('Unexpected storage read'); } },
    'tokenizer.js':{ countTokens:async text => text.length } } });
  const { buildContextForRequest } = await use('context-builder.js'), { extractScene } = await use('scene.js');
  const { makeEntry } = await use('lore-lines.js');
  const names = ['Nera Veyrath','Isolde Veyless','Elise Fen','Liora Fen','Bastian Krail'];
  const entries = [...names.map(name => makeEntry('characters',name)),makeEntry('locations','West Reception Room')];
  const session = { longTermPlan:'Wait for the player’s decision.',memory:{ scene:true,lorebooks:true,memoryBlock:true } };
  const settings = { narratorSystemPrompt:'Narrate.',maxContextTokens:50000,maxResponseTokens:1000 };
  const history = [{ id:'u1',order:1,role:'user',content:'Start.' },
    { id:'a1',order:2,role:'assistant',content:'Krail waits.',scene:extractScene('Krail waits.\n<scene>'+labeled+'</scene>') },
    { id:'u2',order:3,role:'user',content:'Continue.' }];
  const result = await buildContextForRequest(session,settings,{ messages:plain(history),loreEntries:entries,requireLatestUser:true });
  assert.deepEqual(plain(result.report.loaded.filter(x => x.book==='characters').map(x => x.name)),names);
  assert.equal(result.report.scene.place,'West Reception Room');
  assert.equal(result.report.loaded.find(x => x.book==='locations').name,'West Reception Room');
  assert.ok(!result.report.loaded.some(x => x.name==='unknown'));
  assert.match(result.apiMessages.find(x => x.content.includes('Established scene snapshot')).content,/message order 2/);
  history[1].scene=null;
  const missing = await buildContextForRequest(session,settings,{ messages:history,loreEntries:entries,requireLatestUser:true });
  assert.equal(missing.report.scene,null);
  assert.match(missing.report.warnings.join('\n'),/missing scene metadata/i);
});
