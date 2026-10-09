import { isAcceptedTurn, lastUserOrderOf, stripDialogue } from './turn-review.js';
import { canonicalScene, canonicalFromFields, parseSceneFields, readSceneOutput } from './scene-parser.js';
export { canonicalScene, canonicalFromFields, parseSceneFields, readSceneOutput };
import { prompts, renderPrompt } from './system-prompts.js';
export const MAX_SCENE_LENGTH = 2000;
export const SCENE_RULE = (protagonist = '') => renderPrompt(prompts.scene, { PROTAGONIST: protagonist || 'the main character' });
export function normalizeSceneLine(raw) {
  const text = String(raw ?? '').replace(/\s*\n\s*/g, ' ').trim();
  if (text.length > MAX_SCENE_LENGTH) throw new Error(`The scene line exceeds ${MAX_SCENE_LENGTH} characters. Shorten it before saving.`);
  return text || null;
}
export function classifyUserInput(text) {
  text = String(text ?? '').trim();
  const cue = /(?:then|and)\s+(?:continue|advance|narrate|play|resume)|\banyway\b|back to the story/i;
  if (/^<\s*ooc\s*>(?:(?!<\/?\s*ooc)[\s\S])*<\/\s*ooc\s*>$/i.test(text) || /^\(\((?:(?!\(\(|\)\))[\s\S])*\)\)$/.test(text) || /^(?:\(OOC(?:(?!\))[\s\S])*\)|\[OOC(?:(?!\])[\s\S])*\])$/i.test(text)) return 'ooc';
  if (/^(?:OOC\s*[:–-]|\[OOC(?:\]|:)|\(OOC(?:\)|:))/i.test(text)) return cue.test(text) ? 'narrative' : 'ooc';
  const ad=text.match(/^<ad>([\s\S]*?)<\/ad>$/i);
  if (!ad) return 'narrative';
  const body=ad[1].trim();
  if (cue.test(body)) return 'narrative';
  if (/^OOC\b|\b(?:answer|respond)\s+(?:in\s+)?OOC\b/i.test(body)) return 'ooc';
  if (/^(?:who|what|when|where|why|how|which|can|could|would|should|is|are|do|does|did|was|were|has|have)\b[^?]*\?$/i.test(body) || /^(?:summari[sz]e|recap|give(?:\s+me)?\s+(?:a\s+)?summary)\b/i.test(body)) return 'question';
  return 'narrative';
}
export function isPureOoc(text) { return classifyUserInput(text) !== 'narrative'; }
export function extractScene(text) { return readSceneOutput(text).scene; }
export function inspectSceneOutput(text) { const {scene,warning}=readSceneOutput(text); return {scene,warning}; }
export function parseScene(raw) {
  const fields=parseSceneFields(raw);
  const known=x => x && x!=='unknown' ? x : null;
  if (!fields) {
    if (/\b(?:date|time|place|present)\s*:/i.test(String(raw ?? ''))) return {raw:String(raw ?? ''),when:null,time:null,place:null,present:[]};
    const parts=String(raw ?? '').split(/\s*(?:[·|]| - )\s*/).filter(Boolean);
    return {raw:String(raw ?? ''),when:parts.length >= 2 ? known(parts[0]) : null,time:parts.length >= 3 ? known(parts[1]) : null,place:known(parts.length >= 3 ? parts.slice(2).join(', ') : parts.at(-1)),present:[]};
  }
  return {raw:canonicalScene(raw),when:known(fields.date),time:known(fields.time),place:known(fields.place),present:fields.present};
}
export function formatSceneForDisplay(raw) { return String(raw ?? '').replace(/present\s*:\s*/i, ''); }
export function sceneTimeline(messages, { startingScene = null, upToOrder = Infinity, lastUserOrder = lastUserOrderOf(messages,upToOrder) } = {}) {
  const timeline=new Map();
  let effective=canonicalScene(startingScene),fromId=null,fromOrder=effective ? 0 : null,missingStreak=0,kind=effective ? 'seed' : null;
  let ownSeen=false;
  for (const m of [...messages].filter(m => m.order < upToOrder).sort((a,b) => a.order-b.order)) {
    if (m.role!=='assistant') continue;
    let own=null;
    if (!m.ooc && isAcceptedTurn(m,{lastUserOrder})) {
      const candidate=m.sceneCandidate?.scene ?? (typeof m.sceneCandidate==='string' ? m.sceneCandidate : null);
      if (m.acceptance==='pending' && candidate) own=canonicalScene(candidate);
      else if (m.acceptance!=='pending' && m.sceneMeta?.kind!=='carried' && m.scene) {
        own=canonicalScene(m.scene) ?? m.scene;
        const provenance=m.sceneMeta?.provenance;
        if (provenance?.time==='kept' || provenance?.date==='kept') {
          const fields=parseScene(own);
          if (provenance.time==='kept') fields.time=null;
          if (provenance.date==='kept') fields.when=null;
          own=sceneLine(fields);
        }
      }
    }
    if (!m.ooc && !ownSeen && !m.sceneMeta && !m.acceptance && !m.scene) { effective=null;fromId=null;fromOrder=null;kind=null; }
    if (own) { effective=own;fromId=m.id;fromOrder=m.order;missingStreak=0;kind=m.sceneMeta?.kind ?? 'declared';ownSeen=true; }
    else if (!m.ooc) missingStreak++;
    timeline.set(m.id,{own,effective,fromId,fromOrder,missingStreak,kind});
  }
  return timeline;
}
export function latestScene(messages, upToOrder = Infinity, startingScene = null) {
  const value=[...sceneTimeline(messages,{startingScene,upToOrder}).values()].at(-1);
  return value ? {scene:value.effective ? parseScene(value.effective) : null,fromOrder:value.fromOrder,fromId:value.fromId,kind:value.kind,missingStreak:value.missingStreak}
    : {scene:startingScene ? parseScene(startingScene) : null,fromOrder:startingScene ? 0 : null,fromId:null,kind:startingScene ? 'seed' : null,missingStreak:0};
}
export function sceneLine(fields) {
  const raw=canonicalFromFields(fields);
  if (!raw) throw new Error('The scene line exceeds 2000 characters. Shorten it before saving.');
  return raw;
}
export function carryScene(prior) {
  return {scene:null,sceneMeta:{kind:'carried',stale:true,fromOrder:prior?.fromOrder ?? null,fromId:prior?.fromId ?? null,missingStreak:(prior?.missingStreak ?? 0)+1}};
}

const normalized = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const TIME_CLASSES={
  dawn:['dawn','daybreak','sunrise','first light'], morning:['morning','breakfast','forenoon'],
  noon:['noon','midday','luncheon','lunch'], afternoon:['afternoon'],
  evening:['evening','dinner','supper','sundown','lamplighting','lamps were lit'],
  dusk:['dusk','sunset','twilight'], night:['night','midnight','nightfall','goodnight','small hours']
};
const DAY_CHANGE=/\b(?:next day|next morning|the following (?:day|morning)|the morning after|by morning|dawn of the)\b/i;
const LONG_SKIP=/\b(?:(?:days|weeks|months|years) later|a (?:week|month|year) later|the next year)\b/i;
const NEIGHBOURS=['dawn morning','morning noon','noon afternoon','afternoon evening','afternoon dusk','evening dusk','evening night','dusk night','night dawn'];
function supports(text,word,time=false) {
  text=normalized(text);word=normalized(word);
  if (!word) return false;
  const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for (const match of text.matchAll(new RegExp('(?<![\\p{L}\\p{N}])'+escaped+'(?:s|ed|ing)?(?![\\p{L}\\p{N}])','gu'))) {
    if (!time || !/\b(?:last|next|yesterday|tomorrow|previous|that|every)\s*$/.test(text.slice(0,match.index))) return true;
  }
  return false;
}
export function timeClassesIn(text) {
  return new Set(Object.entries(TIME_CLASSES).filter(([,words])=>words.some(word=>supports(text,word,true))).map(([key])=>key));
}
function oneDayForward(previous,next) {
  const old=normalized(previous),fresh=normalized(next),a=[...old.matchAll(/\d+/g)],b=[...fresh.matchAll(/\d+/g)];
  if(a.length!==b.length || !a.length || old.replace(/\d+/g,'#')!==fresh.replace(/\d+/g,'#')) return false;
  let changed=0;
  for(let i=0;i<a.length;i++) {
    if(a[i][0]===b[i][0])continue;
    if(+b[i][0]!==+a[i][0]+1 || (+b[i][0]>31 && !/\bday\s*$/.test(fresh.slice(0,b[i].index))))return false;
    changed++;
  }
  return changed===1;
}
export function sceneFromThinking(thinking) {
  let candidate=null;
  for(const line of String(thinking ?? '').split(/\r?\n/)) {
    const start=line.search(/\bdate\s*:/i);
    if(start<0 || !/·.*\bplace\s*:/i.test(line.slice(start)))continue;
    const raw=line.slice(start).replace(/<\/scene\s*>.*$/i,'').trim();
    const date=raw.match(/^date\s*:\s*([^·]*)/i)?.[1]?.trim();
    const place=raw.match(/·\s*place\s*:\s*([^·]*)/i)?.[1]?.trim();
    if(!date || !place || /^(?:DATE|PLACE|TBD|\.{3}|…)$/i.test(date) || /^(?:DATE|PLACE|TBD|\.{3}|…)$/i.test(place))continue;
    if(canonicalScene(raw))candidate=raw;
  }
  return candidate;
}

// A declared clock is accepted unless the ending narration contradicts it.
export function validateSceneValues(raw, { narration = '', userText = '', prior = null } = {}) {
  const parsed=parseScene(raw),warnings=[],provenance={};
  const narrative=stripDialogue(String(narration).replace(/<(?:scene|plan|plan_thread)>[\s\S]*?<\/(?:scene|plan|plan_thread)>/gi,''));
  const ending=narrative.trim().split(/\n\s*\n/).at(-1) ?? '';
  const progressed=(date,text)=>{
    const old=prior?.when?.match(/^Day (\d+)$/i),next=date?.match(/^Day (\d+)$/i);
    if(!old || !next || +next[1]!==+old[1]+1)return false;
    const ordinal=['','first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth'][+next[1]];
    return DAY_CHANGE.test(text) || !!(ordinal && new RegExp('\\b'+ordinal+' day\\b','i').test(text));
  };
  for(const [key,field] of [['date','when'],['time','time']]) {
    const value=parsed[field],needle=normalized(value),previous=prior?.[field];
    if(!value)provenance[key]='unknown';
    else if(normalized(previous)===needle)provenance[key]='prior';
    else if(supports(userText,needle,key==='time'))provenance[key]='user';
    else {
      let accepted=false;
      if(key==='time') {
        const declared=[...timeClassesIn(value)][0],classes=timeClassesIn(narrative);
        if((declared && classes.has(declared)) || supports(narrative,needle,true) || /^\d{1,2}:00$/.test(value) && new RegExp('\\b'+Number(value.split(':')[0])+" o.clock\\b",'i').test(narrative)) {provenance[key]='narration';accepted=true;}
        else {
          const endClasses=[...timeClassesIn(ending)];
          const compatible=other=>other===declared || NEIGHBOURS.some(pair=>pair.split(' ').includes(other) && pair.split(' ').includes(declared));
          if(!previous || normalized(previous)==='unknown' || !declared || !endClasses.length || endClasses.some(compatible)) {provenance[key]='declared';accepted=true;}
        }
      } else {
        if(supports(narrative,needle) || progressed(value,narrative) || DAY_CHANGE.test(narrative+' '+userText) && oneDayForward(previous,value) || LONG_SKIP.test(narrative+' '+userText)) {provenance[key]='narration';accepted=true;}
        else if(!previous || normalized(previous)==='unknown' || needle.includes(normalized(previous))) {provenance[key]='declared';accepted=true;}
      }
      if(!accepted) {parsed[field]=previous ?? null;provenance[key]='contradicted';warnings.push(`Unsupported scene ${key}; ${parsed[field] ? 'prior value kept' : 'stored as unknown'}.`);}
    }
  }
  return {scene:sceneLine(parsed),sceneMeta:{kind:'declared',stale:false,provenance},warnings};
}
