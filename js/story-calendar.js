// Story dates use modern month lengths, but weekdays come from an author anchor.
export const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
export const daysInMonth = (year,month) => [31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
export function parseStoryDate(value) {
  let text=normalize(value),weekday=null,m;
  const prefix=text.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)[, ]+/);
  if(prefix){weekday=WEEKDAYS.findIndex(d=>d.toLowerCase()===prefix[1]);text=text.slice(prefix[0].length);}
  let year,month,day;
  if((m=text.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/))) [,year,month,day]=m;
  else if((m=text.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{1,4})$/))) {day=m[1];month=m[3];year=m[4];}
  else if((m=text.match(/^(\d{1,2}) ([a-z]+) (\d{1,4})$/))) {day=m[1];month=MONTHS.indexOf(m[2])+1;year=m[3];}
  else if((m=text.match(/^([a-z]+) (\d{1,2}),? (\d{1,4})$/))) {month=MONTHS.indexOf(m[1])+1;day=m[2];year=m[3];}
  else return null;
  year=Number(year);month=Number(month);day=Number(day);
  const valid=year>=1&&year<=9999&&month>=1&&month<=12&&day>=1&&day<=daysInMonth(year,month);
  // Integer civil-day count; no Date constructor, timezone or year-0..99 coercion.
  const y=year-1;
  const ordinal=valid?365*y+Math.floor(y/4)-Math.floor(y/100)+Math.floor(y/400)+Array.from({length:month-1},(_,i)=>daysInMonth(year,i+1)).reduce((a,b)=>a+b,0)+day-1:null;
  return {year,month,day,weekday,valid,ordinal};
}
export function parseClock(value) {
  const m=normalize(value).replace(/^(\d{1,2})\s*([ap]m)$/,'$1:00 $2').match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/);
  if(!m)return null;
  let hour=Number(m[1]);const minute=Number(m[2]);
  if(minute>59||(m[3]?hour<1||hour>12:hour>23))return null;
  if(m[3])hour=hour%12+(m[3]==='pm'?12:0);
  return hour*60+minute;
}
export const clockText = minutes => `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
// An afternoon/evening clock followed by an earlier morning clock is an
// overnight wrap, not a backwards correction. Unknown clocks/dates stay unknown.
export function midnightRolloverDate(previousDate,previousTime,date,time) {
  const before=parseStoryDate(previousDate),after=parseStoryDate(date),oldClock=parseClock(previousTime),clock=parseClock(time);
  if(!before?.valid || !after?.valid || before.ordinal!==after.ordinal || oldClock===null || clock===null || oldClock<720 || clock>=720)return null;
  let {year,month,day}=before;
  if(++day>daysInMonth(year,month)){day=1;if(++month>12){month=1;year++;}}
  if(year>9999)throw new Error('Story date exceeds the supported calendar.');
  return (before.weekday===null?'':WEEKDAYS[(before.weekday+1)%7]+' ')+`${day}/${month}/${year}`;
}
export function normalizeCalendar(raw) {
  if(raw?.mode!=='modern')return {mode:'legacy',anchor:null};
  const date=parseStoryDate(raw.anchor);
  return {mode:'modern',anchor:date?.valid&&date.weekday!==null?`${WEEKDAYS[date.weekday]} ${date.day}/${date.month}/${date.year}`:null};
}
export function formatStoryDate(date,calendar) {
  const anchor=parseStoryDate(calendar?.anchor);
  if(!date?.valid||!anchor?.valid||anchor.weekday===null)throw new Error('Modern time needs a valid weekday and date anchor, such as Friday 21/10/738.');
  const weekday=((anchor.weekday+date.ordinal-anchor.ordinal)%7+7)%7;
  return `${WEEKDAYS[weekday]} ${date.day}/${date.month}/${date.year}`;
}
export function calendarInstruction(raw) {
  const calendar=normalizeCalendar(raw);
  if(calendar.mode!=='modern')return '';
  formatStoryDate(parseStoryDate(calendar.anchor),calendar);
  return `STORY CALENDAR\nUse date: Weekday D/M/YYYY and time: HH:mm (24-hour), for example Friday 21/10/738 and 15:40. The author weekday anchor is ${calendar.anchor}; use modern month lengths and leap years, and advance weekdays from this anchor. Carry unknown precision as unknown. Estimate plausible elapsed time for ordinary actions; obey explicit current timestamps and elapsed durations. At midnight advance date and weekday; a stale same-date overnight clock wrap is normalized to the following date. Quoted, historical and future appointments are not current time. Pure OOC does not advance events or time.`;
}
export function modernSceneReminder(raw,current,planActive=false) {
  const calendar=normalizeCalendar(raw);
  if(calendar.mode!=='modern')return '';
  const date=parseStoryDate(current?.when),clock=parseClock(current?.time);
  const exampleDate=date?.valid?formatStoryDate(date,calendar):'unknown';
  const exampleTime=clock!==null?clockText(clock):'unknown';
  const present=current?.present?.join(', ')||'unknown',place=current?.place||'unknown';
  return `[Current reply reminder: for narrative, put the completed hidden scene tag AFTER the final NPC line or event. Nothing follows </scene>. Omit hidden tags only for pure OOC; OOC keeps time and place unchanged.]\n${planActive?'Write the pending immediate <plan_thread> before the scene tag.\n':''}Use the story weekday/date and 24-hour HH:mm. Carry unknown precision as unknown; advance date and weekday together at midnight.\nThe following is the latest established state, not a fixed ending. Update only changed fields from confirmed events or plausible elapsed time:\n<scene>date: ${exampleDate} · time: ${exampleTime} · place: ${place} · present: ${present}</scene>\nA configured protagonist name, a user instruction mentioning someone, or addressing the user does not establish physical presence. Carry the established attendees unless current input or narrated events establish arrival/departure. Never add the protagonist just because they are configured. End every narrative reply with the updated scene tag even after dialogue.`;
}

const known = value => value&&normalize(value)!=='unknown';
const temporalData = text => String(text ?? '').replace(/<(scene|plan|plan_thread)>[\s\S]*?<\/\1>/gi,'');
const future = /\b(?:tomorrow|yesterday|appointment|scheduled|will|would|next week|last week)\b/i;
const NUMBER_WORDS={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
const durationNumber='(?:\\d+(?:\\.\\d+)?|(?:'+Object.keys(NUMBER_WORDS).join('|')+')(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?)';
function duration(text) {
  const values=[];
  for(const sentence of temporalData(text).split(/(?<=[.!?])\s+|\n+/)) {
    if(future.test(sentence)||! /\b(?:wait(?:ed|s|ing)?|spen[dt]|pass(?:ed|es)?|after|later|elapsed|for|take|takes|took|walk(?:ed|s|ing)?|travel(?:led|s|ing)?|continue)\b/i.test(sentence))continue;
    const matches=[...sentence.matchAll(new RegExp(`\\b(${durationNumber})\\s*(minutes?|hours?|days?)\\b`,'gi'))];
    if(matches.length)values.push(matches.reduce((n,m)=>{
      const amount=/^\d/.test(m[1])?Number(m[1]):m[1].toLowerCase().split(/[ -]/).reduce((sum,w)=>sum+NUMBER_WORDS[w],0);
      return n+amount*({minute:1,hour:60,day:1440}[m[2].toLowerCase().replace(/s$/,'')]);
    },0));
  }
  return values.length===1&&Number.isSafeInteger(values[0])?values[0]:null;
}
const dateTokens=sentence=>[...sentence.matchAll(/(?<![\p{L}\p{N}/.-])(?:\d{3,4}-\d{1,2}-\d{1,2}|\d{1,2}([/.-])\d{1,2}\1\d{1,4}|\d{1,2} [a-z]+ \d{1,4}|[a-z]+ \d{1,2},? \d{1,4})(?![\p{L}\p{N}/.-])/giu)];
function dateEvidence(text,date) {
  return temporalData(text).split(/(?<=[.!?])\s+|\n+/).some(sentence=>!future.test(sentence)&&dateTokens(sentence).some(m=>parseStoryDate(m[0])?.ordinal===date?.ordinal));
}
function clockEvidence(text,clock) {
  return temporalData(text).split(/(?<=[.!?])\s+|\n+/).some(sentence=>!future.test(sentence)&&[...sentence.matchAll(/(?<![\p{L}\p{N}:])\d{1,2}:\d{2}(?:\s*[ap]m)?(?![\p{L}\p{N}:])/giu)].some(m=>parseClock(m[0])===clock));
}
function exactEvidence(text,date,clock,allowClockOnly=false) {
  if(!date?.valid||clock===null)return false;
  for(const sentence of temporalData(text).split(/(?<=[.!?])\s+|\n+/)) {
    if(future.test(sentence))continue;
    const clocks=[...sentence.matchAll(/(?<![\p{L}\p{N}:])(\d{1,2}:\d{2}(?:\s*[ap]m)?)(?![\p{L}\p{N}:])/giu)];
    if(!clocks.some(m=>parseClock(m[0])===clock))continue;
    const dates=dateTokens(sentence);
    if(dates.some(m=>parseStoryDate(m[0])?.ordinal===date.ordinal)||allowClockOnly&&!dates.length)return true;
  }
  return false;
}
export function validateModernTimestamp(fields,{calendar,prior,narration='',userText='',ooc=false}={}) {
  calendar=normalizeCalendar(calendar);
  const previousDate=prior?.when??prior?.date??null,previousTime=prior?.time??null;
  const rejected=reason=>({date:previousDate,time:previousTime,provenance:{date:'contradicted',time:'contradicted'},warnings:[reason]});
  if(ooc)return {date:previousDate,time:previousTime,provenance:{date:'prior',time:'prior'},warnings:[]};
  const date=parseStoryDate(fields.when??fields.date),clock=parseClock(fields.time);
  if(!calendar.anchor)return rejected('Modern time needs a weekday/date anchor.');
  if(known(fields.when??fields.date)&&!date?.valid)return rejected('Invalid modern scene date; prior timestamp kept.');
  if(known(fields.time)&&clock===null)return rejected('Invalid modern scene clock; prior timestamp kept.');
  const oldDate=parseStoryDate(previousDate),oldClock=parseClock(previousTime);
  let effectiveDate=date??(oldDate?.valid?oldDate:null);const effectiveClock=clock??oldClock;
  if(!effectiveDate) {
    if(oldClock===null&&clock!==null&&!clockEvidence(userText,clock)&&!clockEvidence(narration,clock))return rejected('Unsupported new scene clock precision; prior timestamp kept.');
    return {date:null,time:effectiveClock===null?null:clockText(effectiveClock),provenance:{date:'unknown',time:clock!==null?'declared':'prior'},warnings:[]};
  }
  const suppliedFormatted=formatStoryDate(effectiveDate,calendar),expectedWeekday=parseStoryDate(suppliedFormatted).weekday;
  if(date?.weekday!==null&&date?.weekday!==undefined&&date.weekday!==expectedWeekday)return rejected('Scene weekday conflicts with the story anchor; prior timestamp kept.');
  const correctionRequested=/\b(?:correct(?:ion)?|set|actually|rewind|flashback)\b/i.test(userText);
  const rolled=correctionRequested?null:midnightRolloverDate(previousDate,previousTime,`${effectiveDate.day}/${effectiveDate.month}/${effectiveDate.year}`,effectiveClock===null?null:clockText(effectiveClock));
  if(rolled)effectiveDate=parseStoryDate(rolled);
  const formatted=formatStoryDate(effectiveDate,calendar);
  const sameDay=oldDate?.valid&&oldDate.ordinal===effectiveDate.ordinal;
  const userExact=exactEvidence(userText,effectiveDate,effectiveClock,sameDay);
  const narrativeExact=exactEvidence(narration,effectiveDate,effectiveClock,sameDay);
  if(!oldDate?.valid&&date&&!dateEvidence(userText,date)&&!dateEvidence(narration,date))return rejected('Unsupported new scene date precision; prior timestamp kept.');
  if(oldClock===null&&clock!==null&&!userExact&&!narrativeExact)return rejected('Unsupported new scene clock precision; prior timestamp kept.');
  let provenance=userExact?'user':narrativeExact?'narration':'declared';
  if(oldDate?.valid&&oldClock!==null&&effectiveClock!==null) {
    const delta=(effectiveDate.ordinal-oldDate.ordinal)*1440+effectiveClock-oldClock;
    const correction=userExact&&/\b(?:correct(?:ion)?|set|actually|rewind|flashback)\b/i.test(userText);
    if(delta<0&&!correction)return rejected('Unsupported backward scene time; prior timestamp kept.');
    const elapsed=duration(userText)??duration(narration);
    if(elapsed!==null&&!userExact&&delta!==elapsed)return rejected('Scene timestamp conflicts with explicit elapsed time; prior timestamp kept.');
    if(delta===0)provenance='prior';else if(elapsed!==null&&!userExact)provenance='narration';
  }
  return {date:formatted,time:effectiveClock===null?null:clockText(effectiveClock),provenance:{date:provenance,time:provenance},warnings:[]};
}
