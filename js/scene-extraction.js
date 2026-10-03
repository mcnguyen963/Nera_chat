import { prompts } from './system-prompts.js';
import { chatCompletion } from './llm-client.js';
import { countTokens } from './tokenizer.js';
import { sceneLine, carryScene } from './scene.js';

const item = { type:'object',additionalProperties:false,properties:{ name:{ type:'string' },quote:{ type:'string' } },required:['name','quote'] };
export const SCENE_EXTRACTION_FORMAT = { type:'json_schema',json_schema:{ name:'scene_snapshot',strict:true,
  schema:{ type:'object',additionalProperties:false,properties:{
    date:{ type:'string' },time:{ type:'string' },place:{ type:'string' },present:{ type:'array',items:{ type:'string' } },
    evidence:{ type:'object',additionalProperties:false,properties:{ date:{ type:'string' },time:{ type:'string' },place:{ type:'string' },present:{ type:'array',items:item } },required:['date','time','place','present'] },
    departed:{ type:'array',items:item }
  },required:['date','time','place','present','evidence','departed'] } } };

const norm = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const known = text => text?.trim() && !/^unknown$/i.test(text.trim()) ? text.trim() : null;
const outsideQuotes = text => String(text ?? '').replace(/<(?:scene|plan|plan_thread)>[\s\S]*?<\/(?:scene|plan|plan_thread)>/gi,'').replace(/["“][\s\S]*?["”]/g,'');
function exactKeys(obj,keys) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(k=>Object.hasOwn(obj,k));
}
function evidenceItems(value) {
  return Array.isArray(value) && value.length <= 50 && value.every(i => exactKeys(i,['name','quote']) && typeof i.name === 'string' && typeof i.quote === 'string' && i.quote.length <= 4000);
}
function validateShape(obj) {
  if (!exactKeys(obj,['date','time','place','present','evidence','departed'])
    || !['date','time','place'].every(k=>typeof obj[k] === 'string' && obj[k].length <= 200)
    || !Array.isArray(obj.present) || obj.present.length > 50 || obj.present.some(n=>typeof n !== 'string' || !n.trim() || n.length > 200)
    || !exactKeys(obj.evidence,['date','time','place','present'])
    || !['date','time','place'].every(k=>typeof obj.evidence[k] === 'string' && obj.evidence[k].length <= 4000)
    || !evidenceItems(obj.evidence.present) || !evidenceItems(obj.departed)) throw new Error('Invalid scene extraction JSON.');
}

export function sceneExtractionContext({ narration,userText,prior,entries = [],sourceRevision = 0 }) {
  return { narration,userText,prior,sourceRevision,
    characters:entries.filter(e=>e.book === 'characters').map(e=>({ name:e.name,aliases:e.aliases ?? [] })) };
}
export function sceneExtractionMessages(context) {
  return [{ role:'system',content:prompts.sceneExtraction },{ role:'user',content:JSON.stringify({
    priorScene:context.prior?.scene ? { date:context.prior.scene.when ?? 'unknown',time:context.prior.scene.time ?? 'unknown',
      place:context.prior.scene.place ?? 'unknown',present:context.prior.scene.present } : null,
    currentUserInput:context.userText,narration:context.narration,canonicalCharacters:context.characters ?? []
  }) }];
}

// Local checks establish literal support, not semantic truth. Keep the prior
// value when an extracted change is unsupported instead of erasing known state.
export function parseSceneExtraction(text,context) {
  const obj = JSON.parse(text);validateShape(obj);
  const prior = context.prior?.scene, warnings = [],provenance = {},acceptedEvidence = {};
  const user = norm(context.userText),narration = norm(outsideQuotes(context.narration));
  const supports = quote => !!norm(quote) && (user.includes(norm(quote)) || narration.includes(norm(quote)));
  const source = quote => user.includes(norm(quote)) ? 'user' : 'narration';
  const fields = {};
  for (const [key,oldKey] of [['date','when'],['time','time'],['place','place']]) {
    const next = known(obj[key]),old = prior?.[oldKey] ?? null,quote = obj.evidence[key];
    if (norm(next) === norm(old)) { fields[key] = old;provenance[key] = old ? 'prior' : 'unknown'; }
    else if (next && supports(quote) && norm(quote).includes(norm(next))) {
      fields[key] = next;provenance[key] = source(quote);acceptedEvidence[key] = quote;
    } else {
      fields[key] = old;provenance[key] = old ? 'prior' : 'unknown';
      warnings.push(`Unsupported scene ${key} change withheld.`);
    }
  }
  const characters = context.characters ?? [];
  const resolve = name => {
    const canonical = characters.filter(c=>norm(c.name) === norm(name));
    const matches = canonical.length ? canonical : characters.filter(c=>[c.name,...c.aliases].some(n=>norm(n) === norm(name)));
    return matches.length === 1 ? matches[0].name : matches.length > 1 ? null : name.trim();
  };
  const terms = name => {
    const card = characters.find(c=>c.name === name);
    return card ? [card.name,...card.aliases] : [name];
  };
  const mentions = (quote,name) => terms(name).some(term => {
    const pattern = norm(term).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('(?<![\\p{L}\\p{N}])'+pattern+'(?![\\p{L}\\p{N}])','u').test(norm(quote));
  });
  const priorPresent = [...new Set((prior?.present ?? []).map(resolve).filter(Boolean))];
  const present = [],attendanceEvidence = [];
  const evidenceFor = (items,name) => items.find(e=>resolve(e.name) === name && supports(e.quote) && mentions(e.quote,name));
  const departing = quote => /\b(?:leav(?:e|es|ing)|left|exit(?:s|ed)?|depart(?:s|ed)?|step(?:s|ped)? out|out of|outside|backs? out|withdraw(?:s|n)?|walk(?:s|ed)? away)\b/i.test(quote)
    && !/\b(?:will|would|should|could|must|may|might|ordered|asks?|tells?|instructs?|intends?|plans?|if)\b/i.test(quote);
  for (const raw of obj.present) {
    const name = resolve(raw);
    if (!name) { warnings.push(`Ambiguous attendee ${raw} withheld.`);continue; }
    if (present.includes(name)) continue;
    if (priorPresent.includes(name)) { present.push(name);continue; }
    const e = evidenceFor(obj.evidence.present,name);
    if (!e || /\b(?:outside|corridor|hallway|remember|mentioned|expected|will arrive|will enter|ordered to|summoned)\b/i.test(e.quote)
      || departing(e.quote) || !/\b(?:enter(?:s|ed)?|arriv(?:e|es|ed)|join(?:s|ed)?|stand(?:s|ing)?|stood|sit(?:s|ting)?|sat|remain(?:s|ed)?|beside|inside|is in|are in)\b/i.test(e.quote)) { warnings.push(`Unsupported new attendee ${name} withheld.`);continue; }
    present.push(name);attendanceEvidence.push({ name,quote:e.quote,source:source(e.quote) });
  }
  const departures = [];
  for (const name of priorPresent) {
    if (present.includes(name)) continue;
    const e = evidenceFor(obj.departed,name);
    if (e && departing(e.quote)) departures.push({ name,quote:e.quote,source:source(e.quote) });
    else { present.push(name);warnings.push(`Unsupported departure of ${name} withheld.`); }
  }
  acceptedEvidence.present = attendanceEvidence;acceptedEvidence.departed = departures;
  const unsupported = warnings.length > 0;
  const scene = sceneLine({ ...fields,present });
  const carried = unsupported && scene === prior?.raw ? carryScene(context.prior) : null;
  return { scene,sceneMeta:{ ...(carried?.sceneMeta ?? { kind:'inferred',stale:unsupported }),
    provenance,evidence:acceptedEvidence,sourceRevision:context.sourceRevision ?? 0,
    ...(unsupported && !carried ? { missingStreak:(context.prior?.missingStreak ?? 0)+1 } : {}) },warnings };
}

export async function extractSceneState(settings,context,{ signal } = {}) {
  const messages = sceneExtractionMessages(context),maxResponseTokens = 2200;
  const tokens = 24+(await Promise.all(messages.map(m=>countTokens(m.content)))).reduce((a,b)=>a+b,0);
  if (tokens+maxResponseTokens > settings.maxContextTokens) throw new Error('Scene extraction input exceeds the context budget.');
  const openRouter = /^https:\/\/openrouter\.ai\//.test(settings.endpoint);
  const modelId = context.model || (openRouter ? 'z-ai/glm-5.3-flash:floor' : settings.modelId);
  const started = Date.now();
  const reply = await chatCompletion({ settings:{ ...settings,modelId,streaming:false,advancedParametersEnabled:false,
    maxResponseTokens,reasoning:{ ...settings.reasoning,enabled:false } },messages,signal,
    responseFormat:SCENE_EXTRACTION_FORMAT,provider:openRouter ? { require_parameters:true } : undefined });
  const result = parseSceneExtraction(reply.content,context);
  return { ...result,call:{ purpose:'scene extraction',model:modelId,usage:reply.usage ?? null,
    latencyMs:Date.now()-started,status:'complete',validationWarnings:result.warnings } };
}
