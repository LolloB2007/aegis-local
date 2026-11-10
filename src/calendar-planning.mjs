// Deterministic Apple Calendar availability calculations; the LLM never guesses free slots.
import { executeIntegration, validateIntegrationArgs } from './integrations.mjs';

export const CALENDAR_SCHEMAS=Object.freeze({
  calendar_free:{
    from:'ISO8601 beginning of requested period, with explicit timezone',
    to:'ISO8601 end of requested period, with explicit timezone',
    durationMinutes:'Integer 30 to 240, requested uninterrupted minutes',
    dayStart:'Local clock opening time HH:MM, default 09:00',
    dayEnd:'Local clock closing time HH:MM, default 19:00',
    calendar:'Existing exact calendar name or empty for all'
  },
  calendar_check:{
    start:'ISO8601 start timestamp with timezone',
    end:'ISO8601 end timestamp with timezone',
    calendar:'Existing exact calendar name or empty for all'
  }
});
export function calendarPlanningIntent(text) {
  const s=String(text||'').trim();
  if(/^(?:please\s+)?(?:find|show|suggest|look for)\s+.+\b(?:free|available)\s+(?:time|slots?|hours?)\b/i.test(s)||
     /^(?:please\s+)?(?:when am i free|find me (?:a )?(?:free|available) (?:slot|block))\b/i.test(s))
    return 'calendar_free';
  if(/^(?:please\s+)?(?:check|find)\s+(?:for\s+)?(?:calendar\s+)?conflicts?\b/i.test(s)||
     /^(?:please\s+)?(?:am i (?:free|available)|is my calendar free)\b/i.test(s))
    return 'calendar_check';
  return null;
}
const date=s=>{
  if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(s)||
    !Number.isFinite(Date.parse(s))) throw new Error('Time needs an ISO8601 timestamp with explicit timezone.');
  return s;
};
const clock=(s,fallback)=>{
  if(!s)return fallback;
  if(typeof s!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))throw new Error('Working hours must be HH:MM.');
  return s;
};
export function validateCalendarPlanningArgs(intent,raw,now=Date.now()) {
  const p=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
  if(intent==='calendar_free'){
    const from=date(p.from),to=date(p.to),start=Date.parse(from),end=Date.parse(to);
    if(end<=start||end-start>14*86400000||start<now-3600000||start>now+366*86400000)
      throw new Error('Availability period must be in the next year and at most 14 days.');
    const rawMinutes=String(p.durationMinutes||'60');
    if(!/^\d{1,3}$/.test(rawMinutes)||Number(rawMinutes)<30||Number(rawMinutes)>240)
      throw new Error('Requested free block must last 30 to 240 minutes.');
    const dayStart=clock(p.dayStart,'09:00'),dayEnd=clock(p.dayEnd,'19:00');
    if(dayStart>=dayEnd)throw new Error('Working-day start must precede its end.');
    return {from,to,durationMinutes:Number(rawMinutes),dayStart,dayEnd,
      calendar:String(p.calendar||'').trim().slice(0,100)};
  }
  if(intent==='calendar_check'){
    const start=date(p.start),end=date(p.end),a=Date.parse(start),b=Date.parse(end);
    if(b<=a||b-a>24*3600000||a<now-3600000||a>now+366*86400000)
      throw new Error('Check a future interval lasting no more than 24 hours.');
    return {start,end,calendar:String(p.calendar||'').trim().slice(0,100)};
  }
  throw new Error('Unsupported calendar planner.');
}
function eventBounds(event){
  const start=Date.parse(event.start),end=Date.parse(event.end);
  return Number.isFinite(start)&&Number.isFinite(end)&&end>start ?{start,end,title:String(event.title||'Untitled').slice(0,100),calendar:String(event.calendar||'')} : null;
}
function overlaps(a,b,events){return events.filter(e=>e.start<b&&e.end>a);}
export function calculateFreeSlots(events,p,now=Date.now()) {
  const duration=p.durationMinutes*60000,begin=Date.parse(p.from),finish=Date.parse(p.to);
  const candidates=[];
  for(let day=new Date(begin),days=0;days<16&&candidates.length<12;days++){
    const startDay=new Date(day.getFullYear(),day.getMonth(),day.getDate());
    if(startDay.getTime()>=finish)break;
    const open=new Date(startDay);open.setHours(Number(p.dayStart.slice(0,2)),Number(p.dayStart.slice(3)),0,0);
    const close=new Date(startDay);close.setHours(Number(p.dayEnd.slice(0,2)),Number(p.dayEnd.slice(3)),0,0);
    const base=Math.max(open.getTime(),begin,now);
    const aligned=Math.ceil(base/(15*60000))*(15*60000);
    for(let tick=aligned;tick+duration<=Math.min(close.getTime(),finish)&&candidates.length<12;tick+=15*60000){
      if(overlaps(tick,tick+duration,events).length===0)
        candidates.push({start:new Date(tick).toISOString(),end:new Date(tick+duration).toISOString()});
    }
    day=new Date(startDay.getFullYear(),startDay.getMonth(),startDay.getDate()+1);
  }
  return candidates;
}

export async function executeCalendarPlanning(intent,raw,settings) {
  const p=validateCalendarPlanningArgs(intent,raw);
  const from=intent==='calendar_free'?p.from:p.start,to=intent==='calendar_free'?p.to:p.end;
  const params=validateIntegrationArgs('calendar_list',{from,to,calendar:p.calendar},settings);
  const response=await executeIntegration('calendar_list',params,settings);
  if(!Array.isArray(response.details?.events))
    return {text:'Calendar availability could not be verified. No free slots will be invented.',details:{verified:false}};
  if(response.details.events.length>=80)
    return {text:'Too many calendar events to establish reliable availability. Narrow the interval.',details:{verified:false}};
  const events=response.details.events.map(eventBounds).filter(Boolean);
  if(intent==='calendar_check'){
    const conflicts=overlaps(Date.parse(p.start),Date.parse(p.end),events);
    return {text:conflicts.length?'Calendar conflict(s) found:\n'+conflicts.map(e=>'- '+new Date(e.start).toLocaleString()+' '+e.title+' ('+e.calendar+')').join('\n'):
      'No conflicts found in the retrieved calendar events for that interval.',
      details:{verified:true,conflicts}};
  }
  const candidates=calculateFreeSlots(events,p);
  return {text:candidates.length?'Verified candidate free slots ('+p.durationMinutes+' minutes):\n'+
    candidates.map(x=>'- '+new Date(x.start).toLocaleString()+' to '+new Date(x.end).toLocaleTimeString()).join('\n'):
    'No free slots found in that range with those working hours.',
    details:{verified:true,candidates,calendar:p.calendar}};
}
