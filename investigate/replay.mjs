import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appHarness } from '../tests/app-harness.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const captured = await read('investigate/LLM_request.txt');
const exported = await read('investigate/chat-history.jsonl');
const request = JSON.parse(captured);
const records = exported.trim().split(/\r?\n/).map(line => JSON.parse(line));
const { session, lore } = records[0].nera;
const messages = records.slice(1).map(record => ({ ...record.nera.message, content:record.mes }));
const original = messages.at(-1);
const sources = process.argv.includes('--head') ? {
  'lore-select.js':execFileSync('git', ['show','HEAD:js/lore-select.js'], { cwd:root, encoding:'utf8' }),
  'scene.js':execFileSync('git', ['show','HEAD:js/scene.js'], { cwd:root, encoding:'utf8' }),
} : {};
// Selection is exact. Budget fitting below is diagnostic only, never native-model token evidence.
const use = appHarness({ sources, stubs:{ 'messages.js':{ getMessages:async () => { throw new Error('Unexpected storage read'); } },
  'tokenizer.js':{ countTokens:async text => Math.ceil(new TextEncoder().encode(text).length/4) } } });
const scene = await use('scene.js');
const select = await use('lore-select.js');
const { normalizeMemory } = await use('memory-settings.js');
const { buildContextForRequest } = await use('context-builder.js');
const { stripPlan } = await use('plan-parser.js');
const mem = normalizeMemory(session.memory);
const oracle = 'date: 18 September 731 · time: unknown · place: West Reception Room · present: Nera Veyrath, Isolde Veyless, Elise Fen, Liora Fen, Bastian Krail';
const inventory = result => ({
  characters:result.selected.characters.map(x => ({ name:x.entry.name, reason:x.reason })),
  locations:result.selected.locations.map(x => ({ name:x.entry.name, reason:x.reason })),
  skipped:result.skipped.filter(x => ['characters','locations'].includes(x.book)),
  resolved:result.resolved,
});
const firstSelection = select.selectEntries(lore, mem, messages[0].content, null);
const corrected = { ...original, content:'Krail waits beside the unsigned order.', thinking:null,
  scene:oracle, planThread:'P1: await the player’s decision.', ooc:false };
const followup = { id:'fixture-next-user', role:'user', order:3, content:'Continue.', revision:0 };
const settings = { narratorSystemPrompt:(await use('system-prompts.js')).prompts.narrator,
  maxContextTokens:120000, maxResponseTokens:request.max_tokens, keepRecentMessagesAfterSummary:10 };
async function nextTurn(assistant) {
  const history = [messages[0],assistant,followup];
  const current = scene.latestScene(history);
  const built = await buildContextForRequest(session, settings, { messages:history, loreEntries:lore, requireLatestUser:true });
  return { scene:current,
    selection:inventory(select.selectEntries(lore,mem,followup.content,current.scene)),
    loaded:built.report.loaded, skipped:built.report.skipped, warnings:built.report.warnings,
    request:built.apiMessages };
}
const actorNames = oracle.split('present: ')[1].split(', ');
const livePath = process.argv.find(x => x.startsWith('--live='))?.slice(7);
let liveNextTurn = null;
if (livePath) {
  const reply = JSON.parse(await read(livePath));
  const inspected = scene.inspectSceneOutput(reply.content);
  liveNextTurn = {
    source:livePath,
    structure:inspected,
    note:'Offline next-request construction from an actual provider reply; no new provider call. Structural acceptance does not validate player agency or unsupported time.',
    ...await nextTurn({ ...original, content:stripPlan(reply.content), thinking:reply.thinking,
      scene:inspected.scene,planThread:reply.planThread,ooc:false }),
  };
}
const longRaw = 'date: Day 2 · time: night · place: West Reception Room · present: '+Array.from({ length:25 },(_,i) => `Established Character ${i}`).join(', ');
const data = {
  sourceHashes:{ request:createHash('sha256').update(captured).digest('hex'), history:createHash('sha256').update(exported).digest('hex') },
  implementation:process.argv.includes('--head') ? 'HEAD scene and lore selection' : 'working tree',
  budgetCounter:'ceil(UTF-8 bytes / 4), diagnostic approximation; captured maxContextTokens is unavailable',
  request:{ settings:Object.fromEntries(Object.entries(request).filter(([k]) => k !== 'messages')),
    messages:request.messages.map((m,i) => ({ index:i,role:m.role,characters:m.content.length })),
    finalUserMatchesExport:request.messages.at(-1).content.split('</memory>').at(-1).trim() === messages[0].content.trim(),
    narratorMatchesDisk:request.messages[0].content.includes((await read('system prompts/narrator.md')).trim()),
    sceneRuleMatchesDisk:request.messages[0].content.includes((await read('system prompts/scene.md')).trim().replace('{{PROTAGONIST}}',mem.protagonist)),
    loadedHeadings:request.messages.at(-1).content.split('</memory>')[0].match(/^## .+/gm) },
  observed:{ extractedScene:scene.extractScene(original.content), savedScene:original.scene,
    planThread:original.planThread, wordsBeforeHiddenComment:original.content.split('<!--HIDDEN-->')[0].trim().split(/\s+/).length,
    commentReportSurvivesStrip:stripPlan(original.content).includes('<!--HIDDEN-->') },
  oracle:{ raw:oracle, present:actorNames, outside:['Magerrett Veyrath','Taigar Veyrath'],
    note:'Local counterfactual fixture from opening user facts, not a repair to saved history; current time is unsupported.' },
  parseLabeled:scene.parseScene(oracle),
  longScene:{ inputLength:longRaw.length, extractedLength:scene.extractScene('<scene>'+longRaw+'</scene>')?.length,
    parsedNames:scene.parseScene(longRaw).present.length, expectedNames:25 },
  adProgressionClassifiedOoc:scene.isPureOoc('<ad>Continue the hearing. Have Krail leave the room.</ad>'),
  firstSelection:inventory(firstSelection),
  observedNextTurn:await nextTurn(original),
  compliantNextTurn:await nextTurn(corrected),
  ...(liveNextTurn ? { liveNextTurn } : {}),
};
const output = process.argv.find(x => x.startsWith('--out='))?.slice(6) ?? 'investigate/replay-results.json';
await writeFile(new URL(output,root), JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({ output, observed:data.observed, parsedScene:data.parseLabeled,
  longScene:data.longScene, firstCharacters:data.firstSelection.characters,
  nextCharacters:data.compliantNextTurn.selection.characters, nextLocations:data.compliantNextTurn.selection.locations,
  adProgressionClassifiedOoc:data.adProgressionClassifiedOoc,
  ...(liveNextTurn ? { liveNextCharacters:liveNextTurn.selection.characters,
    liveNextLocations:liveNextTurn.selection.locations,liveWarnings:liveNextTurn.warnings } : {}) },null,2));
