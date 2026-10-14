const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function isAcceptedTurn(message, { lastUserOrder = -Infinity, sceneOn = true } = {}) {
  if(message?.directorIncomplete)return false;
  if (message?.role !== 'assistant' || !sceneOn) return true;
  return !['pending','rejected'].includes(message.acceptance) || Number(message.order) < Number(lastUserOrder);
}
export function lastUserOrderOf(messages, upToOrder = Infinity) {
  return messages.reduce((max,m) => m.role === 'user' && m.order < upToOrder ? Math.max(max,m.order) : max,-Infinity);
}
export function stripDialogue(text) {
  return String(text ?? '').split(/(\n\s*\n)/).map(p => p.replace(/“[^”]*(?:”|$)|"[^"]*(?:"|$)/g,'')).join('');
}
export function lintPlayerAgency(text, protagonist = '') {
  const names = [protagonist,protagonist.trim().split(/\s+/)[0]].filter(Boolean).map(escape);
  const player = '(?:you'+(names.length ? '|'+[...new Set(names)].join('|') : '')+')';
  const start = '(?:^|[.!?]\\s+|\\n|,\\s*|\\band\\s+|\\bthen\\s+)';
  const verbs = 'say|says|said|reply|replies|replied|ask|asks|asked|whisper|whispers|whispered|shout|shouts|shouted|tell|tells|told|decide|decides|decided|agree|agrees|agreed|choose|chooses|chose|refuse|refuses|refused|realize|realizes|realized|think|thinks|thought|feel|feels|felt|want|wants|wanted|promise|promises|promised';
  const prose = stripDialogue(String(text ?? '').replace(/<(?:scene|plan|plan_thread)>[\s\S]*?<\/(?:scene|plan|plan_thread)>/gi,''));
  const warnings = [];
  if (new RegExp(start+player+'\\s+(?:'+verbs+')\\b','i').test(prose)) warnings.push('Possible player speech, thoughts or decision written by the narrator.');
  if (/(?:^|\n|[.!?]\s+)(?:I(?:\s+(?:am|was|have|had|do|did|say|said|look|walk|decide|think|feel|want|will|can|reach|take|sit|stand|nod)|['’](?:m|ve|ll|d)))\b/i.test(prose)) warnings.push('Possible first-person player narration.');
  return warnings;
}

// Additive Director diagnostics, not an outcome validator. Flag an explicit
// body gesture missing from the player's input; leave authorized wording alone.
export function lintDirectorGestures(text, { protagonist = '', userText = '' } = {}) {
  const names=[protagonist,protagonist.trim().split(/\s+/)[0]].filter(Boolean).map(escape);
  const player='(?:you'+(names.length?'|'+[...new Set(names)].join('|'):'')+')';
  const gesture='(?:put|puts|placed?|places|rest|rests|raise|raises|lower|lowers|lift|lifts|extend|extends)\\s+(?:your|his|her|their|a|one|both)\\s+(?:hands?|arms?|fists?|feet|foot)\\b';
  const pattern=new RegExp('\\b'+player+'\\s+'+gesture,'gi');
  const namePattern=names.length?new RegExp('\\b(?:'+names.join('|')+')\\b','gi'):null;
  const normalize=value=>{let normalized=String(value);if(namePattern)normalized=normalized.replace(namePattern,'you');return normalized.toLowerCase().replace(/\bi\b/g,'you').replace(/\b(?:my|his|her|their)\b/g,'your').replace(/\b(put|place|rest|raise|lower|lift|extend)s\b/g,'$1').replace(/\s+/g,' ').trim();};
  const authorized=normalize(userText),prose=stripDialogue(text);
  const gestures=[...prose.matchAll(pattern)];
  return gestures.some(m=>!authorized.includes(normalize(m[0]))) ? ['Possible player body gesture added beyond the supplied action.'] : [];
}

export function lintUnestablishedTime(text, { prior = null,userText = '' } = {}) {
  if (prior?.time || /\b(?:it is|it's|now|skip to|advance to|set (?:the )?time (?:to|as))\s+(?:early |late |mid-?)?(?:morning|afternoon|evening|night|noon|midnight)\b/i.test(userText)) return [];
  const prose = stripDialogue(text);
  return /\b(?:all (?:morning|afternoon|evening)|(?:morning|afternoon|evening) (?:light|sun)|(?:it is|it's|now) (?:early |late )?(?:morning|afternoon|evening|night)|midday is coming)\b/i.test(prose)
    ? ['Narration introduces a current time while the scene clock is unknown.'] : [];
}

// NPC quotations can conceal the same agency problem as narrator prose.
// These are review hints, not proof that a claim is false: older history may
// support it. Keep clearly uncertain motive interpretations distinct.
export function lintDirectorHistory(text,{userText=''}={}) {
  const normalize=value=>String(value).toLowerCase().replace(/\bi\b/g,'you').replace(/\bmy\b/g,'your').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
  const authorized=normalize(userText),quotes=String(text??'').match(/“[^”]*(?:”|$)|"[^"]*(?:"|$)/g)??[];
  const physical=/\byou\s+(?:looked|stood|sat|put|placed|held|carried|took)\b/gi;
  const motive=/\byou\s+(?:decided|thought|wanted)\b/i;
  const uncertain=/\b(?:I (?:think|suspect)|it felt|I (?:cannot|can't|don't) know|maybe|perhaps|might|seems|seemed)\b/i;
  const repetition=/\byou (?:said|told|asked)\b[\s\S]{0,80}\b(?:before|yesterday|days? ago|twice a day)\b/i;
  for(const quote of quotes) {
    if([...quote.matchAll(physical)].some(m=>!authorized.includes(normalize(m[0]))) || motive.test(quote)&&!uncertain.test(quote) || repetition.test(quote))
      return ['NPC dialogue recalls player actions or interprets past motives; verify those claims against the story history.'];
  }
  return [];
}
// A narrow chronology hint: an NPC's request followed by narrated compliance
// can hide an extra player turn even when no player dialogue is quoted.
export function lintDirectorResponseBoundary(text) {
  const value=String(text ?? ''),quotes=[...value.matchAll(/“[^”]*(?:”|$)|"[^"]*(?:"|$)/g)];
  const request=/\b(?:say it back|repeat (?:it|that|the)|answer (?:me|that|the question)|tell me|explain (?:it|that|the))\b/i;
  const response=/\byou\s+(?:answer|respond|reply|repeat|explain|tell|say)\b|\byou put\b[^.!?\n]{0,100}\bin order\b|\bwhen you finish\b/i;
  return quotes.some(q=>request.test(q[0])&&response.test(stripDialogue(value.slice(q.index+q[0].length))))
    ? ['NPC request is followed by a narrated player response; verify the user authorized that response.'] : [];
}
