import { parseStoryDate } from './story-calendar.js';

export const PLAN_PREVIEW_DAYS = 7;
export const PLAN_HEADER = '# SCHEDULED AUTHOR PLAN\nThese are author instructions for future opportunities, not historical facts or predetermined outcomes. Respect player choices. Active phases may be pursued now. Upcoming phases are preparation only; do not execute them before their start date. Overdue phases remain pending opportunities, not completed events. Only the author can mark events or phases complete. During a confirmed time skip, consider phases on their scheduled dates along the jump, not all at the destination. Shared overviews do not activate omitted phases. Never infer completion from a passed date.';
export function planDate(value) {
  const date = parseStoryDate(value);
  if (!date?.valid) throw new Error('Enter a valid story date, such as 20/10/738.');
  return `${date.day}/${date.month}/${date.year}`;
}
export function validateSchedule(schedule) {
  if (!schedule || !['pending','completed'].includes(schedule.status) || !Array.isArray(schedule.phases)) throw new Error('Invalid plan schedule.');
  const range = item => {
    const start = parseStoryDate(item.start), end = parseStoryDate(item.end);
    if (!start?.valid || !end?.valid || start.ordinal > end.ordinal) throw new Error('Plan dates must be valid, with the end on or after the start.');
    return {start:start.ordinal,end:end.ordinal};
  };
  const parent = range(schedule), ids = new Set();
  for (const phase of schedule.phases) {
    if (!phase || typeof phase.id !== 'string' || !phase.id || ids.has(phase.id) || typeof phase.title !== 'string' || !phase.title.trim() || typeof phase.text !== 'string' || !phase.text.trim() || !['pending','completed'].includes(phase.status)) throw new Error('Each phase needs a unique ID, title, instructions, and completion status.');
    ids.add(phase.id);
    const dates = range(phase);
    if (dates.start < parent.start || dates.end > parent.end) throw new Error('Phase dates must fall within the event dates.');
  }
  return schedule;
}
export function scheduleRange(item) {
  if(!item)return 'Dates needed';
  const a = parseStoryDate(item.start), b = parseStoryDate(item.end);
  if (!a?.valid || !b?.valid) return 'Dates needed';
  return a.year === b.year && a.month === b.month ? `${a.day}–${b.day}/${a.month}/${a.year}` : `${planDate(item.start)} – ${planDate(item.end)}`;
}
export function planStatus(item, date) {
  if (item.status === 'completed') return 'completed';
  const now = parseStoryDate(date), start = parseStoryDate(item.start), end = parseStoryDate(item.end);
  if (!now?.valid || !start?.valid || !end?.valid) return 'unknown date';
  return now.ordinal > end.ordinal ? 'overdue' : now.ordinal >= start.ordinal ? 'active' : 'upcoming';
}
// A confirmed jump is persisted on its user message, never inferred from prose.
export function validatePlanJump(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid time skip.');
  const from = planDate(value.from), to = planDate(value.to);
  if (parseStoryDate(to).ordinal <= parseStoryDate(from).ordinal) throw new Error('Choose a time skip date after the current story date.');
  return {from,to};
}
export function planJumpInstruction(jump) {
  return jump ? `AUTHOR-CONFIRMED TIME SKIP\nAdvance the story from ${jump.from} toward ${jump.to}. Consider the scheduled opportunities along that interval without assuming they happened or controlling the player. Establish the resulting date in the scene tag.` : '';
}
export function selectScheduledPlan(entries, date, jump = null) {
  const selected = [], skipped = [], warnings = [];
  const now = parseStoryDate(date);
  if (jump) jump = validatePlanJump(jump);
  const destination = jump ? parseStoryDate(jump.to) : now;
  const startDay = jump ? parseStoryDate(jump.from).ordinal : now?.ordinal;
  const relevant = item => {
    const start = parseStoryDate(item.start).ordinal, end = parseStoryDate(item.end).ordinal;
    if (jump && start <= destination.ordinal && end >= startDay) return 'during time skip';
    if (end < startDay) return 'overdue';
    if (start <= startDay) return 'active';
    if (start <= destination.ordinal + PLAN_PREVIEW_DAYS) return 'upcoming';
    return null;
  };
  for (const entry of entries.filter(e => e.book === 'plan')) {
    const skip = reason => skipped.push({entryId:entry.id,book:'plan',name:entry.name,reason});
    try { validateSchedule(entry.schedule); } catch (error) { skip('invalid schedule'); warnings.push(entry.name+': '+error.message); continue; }
    if (entry.schedule.status === 'completed') { skip('completed'); continue; }
    if (!now?.valid && !jump) { skip('story date unavailable'); continue; }
    const units = entry.schedule.phases.length ? entry.schedule.phases : [{id:null,title:entry.name,text:'',...entry.schedule}];
    for (const phase of units) {
      const reason = phase.status === 'completed' ? null : relevant(phase);
      if (reason) selected.push({entry,phase:entry.schedule.phases.length ? phase : null,reason,start:parseStoryDate(phase.start).ordinal});
      else skipped.push({entryId:entry.id,book:'plan',name:entry.name,phaseId:phase.id,phaseTitle:phase.title,reason:phase.status === 'completed' ? 'completed phase' : 'outside seven-day preview'});
    }
  }
  if (entries.some(e=>e.book==='plan' && e.schedule?.status!=='completed') && !now?.valid && !jump) warnings.push('Scheduled plan omitted: set a valid modern story date in Memory settings → Starting scene or edit the scene date.');
  const priorities = {active:0,'during time skip':0,overdue:1,upcoming:2};
  selected.sort((a,b)=>priorities[a.reason]-priorities[b.reason] || a.start-b.start || a.entry.id.localeCompare(b.entry.id) || (a.phase?.id ?? '').localeCompare(b.phase?.id ?? ''));
  return {selected,skipped,warnings};
}
export function renderPlanOverview(entry) {
  const section = entry.sections.text;
  return [section.text,...(section.lines ?? []).map(l=>l.text)].filter(Boolean).join('\n');
}
export function mergePlanSchedule(mine, file, choice) {
  validateSchedule(file);
  if (!mine || choice === 'file') return structuredClone(file);
  validateSchedule(mine);
  if (JSON.stringify(mine) === JSON.stringify(file) || choice === 'mine') return structuredClone(mine);
  const merged = structuredClone(mine);
  merged.start = parseStoryDate(mine.start).ordinal <= parseStoryDate(file.start).ordinal ? mine.start : file.start;
  merged.end = parseStoryDate(mine.end).ordinal >= parseStoryDate(file.end).ordinal ? mine.end : file.end;
  merged.status = mine.status === 'completed' && file.status === 'completed' ? 'completed' : 'pending';
  for (const incoming of file.phases) {
    if (merged.phases.some(p => ['title','start','end','text','status'].every(k=>p[k]===incoming[k]))) continue;
    const phase = structuredClone(incoming);
    while (merged.phases.some(p=>p.id===phase.id)) phase.id += '_import';
    merged.phases.push(phase);
  }
  return merged;
}
export function renderPlanUnit(item, includeOverview = true) {
  const {entry,phase,reason} = item;
  return [`## ${entry.name} (${scheduleRange(entry.schedule)})`,includeOverview && renderPlanOverview(entry),phase ? `### ${phase.title} · ${reason} · ${scheduleRange(phase)}\n${phase.text}` : `Status: ${reason}`].filter(Boolean).join('\n');
}
export async function fitScheduledPlan(selected, budget, count) {
  const included = [], skipped = [], overviews = new Set(); let text = '';
  for (const item of selected) {
    const unit = renderPlanUnit(item,!overviews.has(item.entry.id));
    const candidate = text ? text+'\n\n'+unit : PLAN_HEADER+'\n\n'+unit;
    if (await count(candidate) > budget) { skipped.push({entryId:item.entry.id,book:'plan',name:item.entry.name,phaseId:item.phase?.id ?? null,phaseTitle:item.phase?.title ?? null,reason:'over budget'}); continue; }
    const tokens = await count(unit); text = candidate; overviews.add(item.entry.id);
    included.push({...item,tokens,phaseId:item.phase?.id ?? null,phaseTitle:item.phase?.title ?? null,lineIds:new Set(),linesSent:0,linesCut:0});
  }
  return {text,included,skipped,tokens:await count(text),cut:skipped.length};
}
