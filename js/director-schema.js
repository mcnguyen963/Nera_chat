import { normalizeName } from './lore-lines.js';
export const isDirectorSchemaEndpoint=settings=>/^https:\/\/openrouter\.ai\//i.test(settings.endpoint ?? '');
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string={type:'string'};
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
// Native Claude schemas reject maxItems/minimum; keep limits in descriptions
// and enforce them in parseDirectorContract/validateDirectorState.
const list=(items,limit=100)=>({type:'array',items,description:limit===0?'Must be empty; no choices are offered.':'At most '+limit+' entries.'});
const reference=(name,values)=>values.length ? list({$ref:'#/$defs/'+name}) : list(string,0);

// Keep the wire schema separate from local semantic validation. In particular,
// provider JSON schema cannot establish that a character is actually at a place.
export function directorResponseFormat(settings,{entries,before,offeredIds,protagonist='',focusLimit=5}) {
  if(!isDirectorSchemaEndpoint(settings))return {type:'json_object'};
  const offered=new Set(offeredIds),memoryIds=entries.filter(e=>offered.has(e.id)).map(e=>e.id);
  const characterIds=entries.filter(e=>offered.has(e.id)&&e.book==='characters'&&![e.name,...(e.aliases ?? [])].some(n=>normalizeName(n)===normalizeName(protagonist))).map(e=>e.id);
  const metadata=nullable(object({kind:{type:'string',enum:['appointment','commitment','ongoing']},dueDate:nullable(string),dueTime:nullable(string),participants:list(string),location:nullable(string),outcome:nullable({type:'string',enum:['resolved','cancelled','expired-unresolved','background-unresolved']})}));
  const item=object({id:string,text:string,status:{type:'string',enum:['open','active','waiting','ready','closed','cancelled']},trigger:string,source:string,threadMeta:metadata});
  const operations=group=>object({upsert:list({$ref:'#/$defs/ledgerItem'},200),close:before[group].length?list({type:'string',enum:before[group].map(i=>i.id)},200):list(string,0)});
  const scene=object({date:nullable(string),...(before.version===2?{time:nullable({...string,description:'Modern 24-hour HH:mm; retain unknown precision as null.'})}:{hour:nullable({type:'integer',enum:Array.from({length:24},(_,i)=>i+1)})}),location:nullable(string),present:list(string)});
  const event=nullable(object({id:string,name:string,phase:string}));
  const updates={anyOf:[object({}),object({scene,event,decisions:operations('decisions'),threads:operations('threads'),commitments:operations('commitments')})]};
  const focus=reference('characterId',characterIds);
  focus.description=(characterIds.length?'At most '+focusLimit+' NPCs. ':'Must be empty; no NPC choices are offered. ')+'NPCs present in the resulting scene only. Do not put absent encounter targets here.';
  const encounter=reference('characterId',characterIds);encounter.description=(characterIds.length?'At most 100. ':'Must be empty; no NPC choices are offered. ')+'Established NPCs the player is seeking. Selection does not establish presence; update scene.present only for an authorized realized encounter.';
  const schema=object({version:{type:'integer',enum:[1]},action:{type:'string',enum:['narrate','answer','wait']},transition:{type:'string',enum:['attempted','blocked','completed','unchanged']},objective:{type:'string',description:'Realize authorized actions. NPCs may respond or accept invitations without a new player choice.'},stopCondition:{type:'string',description:'Stop before the next voluntary player decision, not automatically before an NPC response.'},memoryIds:reference('memoryId',memoryIds),requiredMemoryIds:reference('memoryId',memoryIds),focusCharacterIds:focus,encounterCharacterIds:encounter,updates});
  schema.$defs={ledgerItem:item,...(memoryIds.length?{memoryId:{type:'string',enum:memoryIds}}:{}),...(characterIds.length?{characterId:{type:'string',enum:characterIds}}:{})};
  return {type:'json_schema',json_schema:{name:'director_turn',strict:true,schema}};
}
