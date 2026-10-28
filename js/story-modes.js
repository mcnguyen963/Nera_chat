import {currentUid} from './auth.js';
import {createSession, updateSession, deleteSession} from './sessions.js';
import {addMessagesBulk} from './messages.js';
import {importLore} from './lore-store.js';
import {fromMarkdown} from './lore-format.js';
import {normalizeMemory} from './memory-settings.js';
import {makeEntry} from './lore-lines.js';

const introduction = `18 September, Imperial Year 731. You awaken as Nera Veyrath, the eleven-year-old third child of Duke Cassian. You remember fragments of Asterfall: Crowns of the Last Dawn, a game whose possible routes ended badly for Nera. Those futures have not happened, and your memories are incomplete. The people around you remember the boy's cruelty even if you choose differently. You have not mastered your magic or swordsmanship. Romance belongs to adulthood; your sisters are family.\n\n`;

export const storyModes = Object.freeze([
  {id:'hearing', title:'The Household Hearing', description:'A fire, an unsigned punishment order, and two lives in your hands.', opening:introduction+`Rain runs down the windows of the west reception room. The fire is out, but the smell of smoke remains. Your mother's damaged portrait leans against a wall.\n\nLiora Fen and her mother Elise stand before your desk, both injured but alive. Liora took her mother's keys and accidentally started the fire while trying to repair a silver nightingale. Neither has been beaten or seen by a physician.\n\nSteward Bastian Krail has laid an unsigned punishment order before you, accusing Elise of negligence and connecting her to a missing shipping folio. Isolde stands quietly at your side. Krail places your pen beside the paper.\n\n“Your decision, Lord Nera.”`},
  {id:'summons', title:'The Duke’s Summons', description:'Face your father and decide what kind of heir you intend to become.', opening:introduction+`A servant leads you through the estate to your father's study. Duke Cassian Veyrath waits behind a desk crowded with military reports and household accounts. Lucien's name appears on one document; yours is written on another.\n\nCassian has heard of your treatment of the servants and the damage your reputation does to the house. He wants to know whether you can be useful or whether you will remain another burden to be managed. Isolde waits outside the door.\n\n“Tell me, Nera,” the duke says, “what do you intend to do with the position you have been given?”`},
  {id:'bond', title:'A Bond and a Secret', description:'Investigate a troubling household record with Isolde at your side.', opening:introduction+`Isolde finds you in the quiet of your mother's former wing. Your bonded maid places a folded household notice on the table: a servant is to be sent away before nightfall, and the reason has been left blank. A second copy bears an unfamiliar mark.\n\nIsolde has followed the notice to your rooms but has not confronted anyone. She cannot disobey an order to protect you, yet she can observe, question and make judgments of her own. The servant's name is on the page; what happened and who issued the order remain unknown.\n\n“Shall I find the steward, Lord Nera?” she asks.`}
]);

function find(entries, book, name) {
  const entry=entries.find(e=>e.book===book && e.name===name);
  if(!entry)throw new Error('The starting lorebook is missing '+name+'.');
  return entry;
}
function addThread(entries,name,text){
  const entry=makeEntry('events',name,{kind:'thread',status:'open',createdFrom:'import'});
  entry.sections.text.text=text;entries.push(entry);
}
export function prepareStoryMode(id, markdown) {
  const mode=storyModes.find(item=>item.id===id);
  if(!mode)throw new Error('Unknown story mode.');
  const parsed=fromMarkdown(markdown);
  if(parsed.warnings.length)throw new Error('The starting lorebook could not be read cleanly.');
  const entries=parsed.entries;
  if(!entries.length)throw new Error('The starting lorebook is empty.');
  if(id==='hearing'){
    find(entries,'characters','Liora Fen').sections.status.text+=' Injured in the accidental fire; detained with Elise for the hearing and not yet examined by a physician.';
    find(entries,'characters','Elise Fen').sections.status.text+=' Injured while putting out the fire; detained with Liora for the hearing and not yet examined by a physician.';
    find(entries,'characters','Bastian Krail').sections.status.text+=' He has presented an unsigned punishment order for the fire and alleges that a shipping folio is missing.';
    const ilyra=find(entries,'characters','Ilyra Veyrath');
    ilyra.sections.notes.text=ilyra.sections.notes.text.replace('A portrait of Ilyra remains in her former rooms.','Her portrait was damaged in the fire and moved to the west reception room.');
    find(entries,'locations','West Reception Room').sections.state.text='The fire is out. Elise and Liora are detained here, injured but alive, while Krail waits for Nera’s decision on an unsigned order.';
    addThread(entries,'The household hearing','Liora accidentally started a fire. Elise and Liora are injured, and Krail has asked Nera to sign a punishment order. No punishment has been decided.');
    addThread(entries,'The missing shipping folio','Krail links a missing folio to the fire. What happened to it is not yet established in play.');
  }
  if(id==='summons')addThread(entries,'The duke’s summons','Cassian has summoned Nera to discuss his reputation and position in the household.');
  if(id==='bond')addThread(entries,'The household notice','A notice orders an unnamed servant sent away without giving a reason. Its origin and purpose are unconfirmed.');
  return {mode,entries};
}

export async function createStoryMode(id,{isCurrent=()=>true}={}) {
  const owner=currentUid();
  const check=()=>{if(!owner || owner!==currentUid() || !isCurrent())throw new Error('Story creation cancelled because the account changed.');};
  check();
  const response=await fetch(new URL('../resources/story-modes/asterfall-lore.md',import.meta.url),{cache:'no-cache'});
  if(!response.ok)throw new Error('Could not load the starting lorebook.');
  const {mode,entries}=prepareStoryMode(id,await response.text());check();
  const sid=await createSession(mode.title,{importing:true});
  try {
    check();
    await addMessagesBulk(sid,[{role:'assistant',content:mode.opening}]);check();
    await importLore({id:sid,uid:owner},{writes:entries.map(entry=>({id:entry.id,data:entry}))},[],{isCurrent:()=>owner===currentUid() && isCurrent()});check();
    const memory=normalizeMemory();memory.lorebooks=true;memory.characterSelection=true;memory.protagonist='Nera Veyrath';
    await updateSession(sid,{memory,importing:false});check();
    return sid;
  } catch(error) {
    if(owner===currentUid())try{await deleteSession(sid);}catch(cleanup){console.error('Incomplete story cleanup will resume:',cleanup);}
    throw error;
  }
}
