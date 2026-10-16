export const EVAL_MODEL='deepseek/deepseek-v4.1-flash:floor';
export const EVAL_LIMITS=Object.freeze({budget:0.10,calls:8,prompt:0.25,completion:0.5});
export const EXPANDED_EVAL_LIMITS=Object.freeze({...EVAL_LIMITS,budget:0.20,calls:24});
const micros=value=>Math.ceil(value*1e6);
export class EvaluationBudget {
  constructor(rows=[],limits=EVAL_LIMITS) {
    if(!Number.isFinite(limits.budget)||limits.budget<=0||limits.budget>0.20||!Number.isInteger(limits.calls)||limits.calls<1||limits.calls>24)throw new Error('Invalid evaluation limits.');
    this.rows=rows;this.limits=Object.freeze({...EVAL_LIMITS,...limits});
  }
  get charged() {return this.rows.reduce((n,r)=>n+(r.actualMicros??r.reservedMicros),0);}
  reserve({scenario,inputBound,maxTokens}) {
    if(this.rows.some(r=>r.status==='started'||r.status==='unresolved'||r.status==='over-bound'))throw new Error('Previous call usage is unresolved or exceeded its bound; no further paid calls allowed.');
    if(this.rows.length>=this.limits.calls)throw new Error(this.limits.calls===8?'Eight-call ceiling reached.':this.limits.calls+'-call ceiling reached.');
    if(!Number.isSafeInteger(inputBound)||inputBound<0||!Number.isSafeInteger(maxTokens)||maxTokens<1)throw new Error('Invalid cost bound.');
    const reservedMicros=micros((inputBound*this.limits.prompt+maxTokens*this.limits.completion)/1e6);
    if(this.charged+reservedMicros>micros(this.limits.budget))throw new Error('$'+this.limits.budget.toFixed(2)+' test budget cannot cover the next request.');
    const row={number:this.rows.length+1,scenario,reservedMicros,inputBound,maxTokens,status:'started',startedAt:new Date().toISOString()};this.rows.push(row);return row;
  }
  settle(row,usage) {
    // Missing cost stays reserved and blocks the next call; errors do not erase spend.
    if(typeof usage?.cost!=='number'||!Number.isFinite(usage.cost)||usage.cost<0){row.status='unresolved';return;}
    row.actualMicros=micros(usage.cost);row.usage=usage;row.status='received';
    if(row.actualMicros>row.reservedMicros){row.status='over-bound';throw new Error('Provider cost exceeded the reserved bound; evaluation stopped.');}
  }
}
export function inputBounds(body,estimatedTokens) {
  // Production tokenizer estimates compatibility; UTF-8 bytes bound ordinary
  // text tokenization, with generous framing and request overhead reserved too.
  const byteTokens=1024+(body.response_format ? new TextEncoder().encode(JSON.stringify(body.response_format)).length : 0)+body.messages.reduce((n,m)=>n+new TextEncoder().encode(m.content).length+64,0);
  return {estimatedTokens,inputBound:Math.max(byteTokens,estimatedTokens)};
}
export function eligibleEndpoints(data,inputBound=0,maxTokens=8192) {
  if(data?.id!=='deepseek/deepseek-v4.1-flash'||!Array.isArray(data.endpoints))return [];
  return data.endpoints.filter(e=>{
    const p=Number(e.pricing?.prompt),c=Number(e.pricing?.completion),request=Number(e.pricing?.request??0);
    const supported=e.supported_parameters??[];
    return Number.isFinite(p)&&p>=0&&p<=EVAL_LIMITS.prompt/1e6&&Number.isFinite(c)&&c>=0&&c<=EVAL_LIMITS.completion/1e6&&request===0&&supported.includes('reasoning')&&supported.includes('max_tokens')&&e.context_length>=inputBound+maxTokens&&(e.max_completion_tokens??e.context_length)>=maxTokens;
  });
}
export function followupProbes(fixture,calendar,scene,failedContext) {
  if(!fixture.synthetic)throw new Error('Follow-up probes currently require the synthetic fixture.');
  const authorCalendar=fixture.session.memory.calendar;
  const date=value=>calendar.formatStoryDate(calendar.parseStoryDate(value),authorCalendar);
  function seed(name,{when='21/10/738',time='15:40',present=['Mira Vale']}={}) {
    const raw=scene.sceneLine({when:date(when),time,place:'Stone Inn',present});
    const alone=present.length===1;
    return [{id:name+'-seed-user',order:1,role:'user',revision:0,content:alone?'Mira Vale is alone at Stone Inn. Traveler is elsewhere and is not physically present.':'Mira Vale and Traveler are physically present at Stone Inn.'},{id:name+'-seed-assistant',order:2,role:'assistant',revision:0,content:alone?'Mira Vale waits alone by the clock. Traveler has not entered.':'Mira Vale waits by the clock beside Traveler.',scene:raw,sceneMeta:{kind:'manual',stale:false}}];
  }
  const replay=failedContext.history.slice(0,-1),replayInput=failedContext.history.at(-1).content;
  const rows=[1,2].map(i=>({name:'followup-tag-'+i,history:replay,input:replayInput,expected:{}}));
  for(const i of [1,2])rows.push({name:'followup-absent-'+i,history:seed('absent-'+i),input:i===1?'<ad>Have Mira Vale check the recovered letter. Do not choose Traveler’s actions or speech.</ad>':'<ad>Continue Mira Vale’s quiet wait at the inn. Traveler remains elsewhere. Do not choose Traveler’s actions.</ad>',expected:{present:['Mira Vale']}});
  rows.push({name:'followup-entry',history:seed('entry'),input:'<ad>Traveler’s arrival at Stone Inn is now established. Traveler enters and remains with Mira Vale. Narrate the NPC response only.</ad>',expected:{present:['Traveler','Mira Vale']}});
  rows.push({name:'followup-exit',history:seed('exit',{present:['Traveler','Mira Vale']}),input:'<ad>Traveler leaves Stone Inn and is no longer physically present. Mira Vale stays at the inn. Narrate the NPC response only.</ad>',expected:{present:['Mira Vale']}});
  for(const [name,before,after] of [['month','31/10/738','1/11/738'],['year','31/12/738','1/1/739'],['leap','28/2/740','29/2/740']])rows.push({name:'followup-'+name,history:seed(name,{when:before,time:'23:55'}),input:'<ad>Ten minutes pass while Mira Vale waits alone in place. End at the resulting timestamp. Traveler stays elsewhere.</ad>',expected:{when:date(after),time:'00:05',present:['Mira Vale']}});
  rows.push({name:'followup-ampm',history:seed('ampm',{time:'3:40 PM'}),input:'<ad>Mira Vale waits alone for fifteen minutes. End at the resulting timestamp using the modern 24-hour clock. Traveler stays elsewhere.</ad>',expected:{when:date('21/10/738'),time:'15:55',present:['Mira Vale']}});
  rows.push({name:'followup-future-quote',history:seed('future'),input:'<ad>Have Mira Vale say, "Tomorrow’s appointment is at 17:10." Keep the current date and time unchanged; do not advance time. Traveler stays elsewhere.</ad>',expected:{when:date('21/10/738'),time:'15:40',present:['Mira Vale']}});
  rows.push({name:'followup-ooc',history:seed('ooc'),input:'<OOC>Report the current date, time, and place without advancing events.</OOC>',expected:{visibleTerms:['Friday','21/10/738','15:40','Stone Inn']}});
  return rows;
}
export async function syntheticFixture(use) {
  const {makeEntry}=await use('lore-lines.js'),r=await use('lore-records.js');
  const mira=makeEntry('characters','Mira Vale');mira.id='mira';mira.sections.personality.text='Reserved, precise, and courteous. Cooperation does not imply affection.';mira.sections.appearance.text='Black hair and a silver cloak.';mira.sections.notes.text='Unrelated background: a distant festival had a different banner each summer. '.repeat(500);mira.sections.notes.lines=[{id:'old-immunity',text:'Mira Vale is immune to moonflower poison, but not to ordinary poisons.',by:'user',turn:1,at:1}];
  const inn=makeEntry('locations','Stone Inn');inn.id='inn';inn.sections.description.text='A quiet stone inn with a clock above the hearth.';
  const rule=makeEntry('facts','Moonflower poison');rule.id='poison-rule';rule.alwaysLoad=true;rule.sections.text.text='Moonflower poison is toxic to people without a documented immunity. Immunity to one poison never implies universal immunity.';
  const timeline=makeEntry('events','Timeline',{kind:'timeline'});timeline.id='timeline';timeline.sections.text.lines=[{id:'letter-found',text:'Mira Vale recovered the sealed letter at Stone Inn.',by:'user',turn:1,at:1}];
  const thread=makeEntry('events','Missing letter',{kind:'thread',status:'closed'});thread.id='letter-thread';thread.sections.text.text='The letter was recovered. The search is closed.';
  const lore=[mira,inn,rule,timeline,thread].map(e=>r.reconcileRecords(e));
  for(const record of lore[0].recordLayout.records.filter(x=>['characterization','appearance'].includes(x.category)))r.approveRecord(lore[0],record);
  const seed='date: Friday 21/10/738 · time: 15:40 · place: Stone Inn · present: Mira Vale';
  return {synthetic:true,session:{id:'eval-local',loreSchemaVersion:3,memory:{scene:true,lorebooks:true,protagonist:'Traveler',calendar:{mode:'modern',anchor:'Friday 21/10/738'},startingScene:seed,loreLookbackMessages:4,batchTurns:2,lagTurns:0,books:{characters:{on:true,budget:1800,maxCards:6},locations:{on:true,budget:800,maxCards:2},facts:{on:true,budget:800},events:{on:true,budget:1000}}}},lore,messages:[{id:'u1',order:1,role:'user',revision:0,content:'At Stone Inn, Mira Vale has just recovered the letter.'},{id:'a1',order:2,role:'assistant',revision:0,content:'Mira Vale puts the recovered letter safely in her silver cloak. She waits by the clock.',scene:seed}],expected:{constraintTerms:['moonflower','immune'],newNote:'Mira Vale locked the recovered letter in the blue chest.',noteTerms:['blue','chest','letter']}};
}
export async function normalizeFixture(raw,use) {
  if(!raw?.session||!Array.isArray(raw.lore)||!Array.isArray(raw.messages)||!raw.messages.length)throw new Error('Fixture requires session, lore and nonempty messages.');
  const {fromRecordDocument,reconcileRecords}=await use('lore-records.js'),{normalizeMemory}=await use('memory-settings.js');
  const fixture=structuredClone(raw);fixture.lore=raw.lore.map(e=>reconcileRecords(e.subject?fromRecordDocument(e):e));fixture.session.memory=normalizeMemory(raw.session.memory);
  if(fixture.session.memory.calendar.mode!=='modern'||!fixture.session.memory.calendar.anchor)throw new Error('Set an explicit modern story calendar anchor in the evaluation fixture.');
  // Synthetic scenario expectations must be declared for external story exports.
  if(!fixture.expected?.newNote||!Array.isArray(fixture.expected.constraintTerms)||!fixture.expected.noteTerms?.length)throw new Error('Fixture needs expected.newNote, expected.noteTerms and expected.constraintTerms for evaluation.');
  return fixture;
}
