const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function isAcceptedTurn(message, protagonist = '') {
  if (!message) return false;
  if (['pending','rejected'].includes(message.acceptance)) return false;
  if (message.acceptance === 'accepted' || message.role !== 'assistant' || message.ooc) return true;
  return lintPlayerAgency(message.content,protagonist).length === 0;
}
export function lintPlayerAgency(text, protagonist = '') {
  const prose = String(text ?? '').replace(/<(?:scene|plan|plan_thread)>[\s\S]*?<\/(?:scene|plan|plan_thread)>/gi,'');
  const names = [protagonist,protagonist.trim().split(/\s+/)[0]].filter(Boolean).map(escape);
  const player = '(?:you'+(names.length ? '|'+[...new Set(names)].join('|') : '')+')';
  const warnings = [];
  const unquoted = prose.replace(/["“][\s\S]*?["”]/g,'');
  if (new RegExp('\\b'+player+'\\s+(?:say|says|said|reply|replies|replied|ask|asks|asked|whisper|whispers|whispered|shout|shouts|shouted|decide|decides|decided|think|thinks|thought|realize|realizes|realized|choose|chooses|chose|glance|glances|nod|nods|reach|reaches|sign|signs|smile|smiles|shrug|shrugs|turn|turns|take|takes)\\b','i').test(unquoted)
    || /\byour (?:gaze|glance|hand) (?:flicks|crosses|moves|reaches|lifts|closes)\b/i.test(unquoted)
    || /["“][^"”\n]+["”][\s\S]{0,200}\byour (?:own )?voice\b/i.test(prose)) warnings.push('Possible player speech, thoughts, action or decision written by the narrator.');
  if (/(?:^|\n|[.!?]\s+)(?:I(?:\s+(?:am|was|have|had|do|did|say|said|look|walk|decide|think|feel|want|will|can|reach|take|sit|stand|nod)|['’](?:m|ve|ll|d)))\b/i.test(unquoted)) warnings.push('Possible first-person player narration.');
  return warnings;
}

export function lintUnestablishedTime(text, { prior = null,userText = '' } = {}) {
  if (prior?.time || /\b(?:it is|it's|now|skip to|advance to|set (?:the )?time (?:to|as))\s+(?:early |late |mid-?)?(?:morning|afternoon|evening|night|noon|midnight)\b/i.test(userText)) return [];
  const prose = String(text ?? '').replace(/["“][\s\S]*?["”]/g,'');
  return /\b(?:all (?:morning|afternoon|evening)|(?:morning|afternoon|evening) (?:light|sun)|(?:it is|it's|now) (?:early |late )?(?:morning|afternoon|evening|night)|midday is coming)\b/i.test(prose)
    ? ['Narration introduces a current time while the scene clock is unknown.'] : [];
}
