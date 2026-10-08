const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function isAcceptedTurn(message, { lastUserOrder = -Infinity, sceneOn = true } = {}) {
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

export function lintUnestablishedTime(text, { prior = null,userText = '' } = {}) {
  if (prior?.time || /\b(?:it is|it's|now|skip to|advance to|set (?:the )?time (?:to|as))\s+(?:early |late |mid-?)?(?:morning|afternoon|evening|night|noon|midnight)\b/i.test(userText)) return [];
  const prose = stripDialogue(text);
  return /\b(?:all (?:morning|afternoon|evening)|(?:morning|afternoon|evening) (?:light|sun)|(?:it is|it's|now) (?:early |late )?(?:morning|afternoon|evening|night)|midday is coming)\b/i.test(prose)
    ? ['Narration introduces a current time while the scene clock is unknown.'] : [];
}
