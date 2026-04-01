import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const RECURRING_KEY = 'noa_recurring_schedule';
const BACKLOG_KEY = 'noa_backlog';
const RECURRING_TASKS_KEY = 'noa_recurring_tasks';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const {
    clientDate, clientTime, priorities, weekHabits, energy,
    racingChecklist, semesterGoals, todayDW,
  } = req.body;

  const todayISO = clientDate || new Date().toLocaleDateString('en-CA');
  const hour = clientTime ? parseInt(clientTime.match(/(\d+):/)?.[1] || '12') + (clientTime.includes('PM') && !clientTime.startsWith('12') ? 12 : 0) : new Date().getHours();
  const isMorning = hour < 14;
  const briefType = isMorning ? 'morning' : 'evening';

  const todayReadable = new Date(todayISO + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  // Tomorrow
  const tomorrowDate = new Date(todayISO + 'T12:00:00');
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowISO = tomorrowDate.toLocaleDateString('en-CA');

  const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

  // Load Redis data in parallel
  let recurringSchedule = {}, todaySchedule = [], tomorrowSchedule = [], backlog = [], recurringTasks = [];
  try {
    [recurringSchedule, todaySchedule, tomorrowSchedule, backlog, recurringTasks] = await Promise.all([
      kv.get(RECURRING_KEY).then(v => v || {}).catch(() => ({})),
      kv.get(`noa_schedule_${todayISO}`).then(v => v || []).catch(() => []),
      kv.get(`noa_schedule_${tomorrowISO}`).then(v => v || []).catch(() => []),
      kv.get(BACKLOG_KEY).then(v => v || []).catch(() => []),
      kv.get(RECURRING_TASKS_KEY).then(v => v || []).catch(() => []),
    ]);
  } catch(e) {}

  // Build today's full schedule
  const todayDayName = DAYS[new Date(todayISO + 'T12:00:00').getDay()];
  const recurringToday = recurringSchedule[todayDayName] || [];
  const fullToday = [...recurringToday, ...todaySchedule].sort((a, b) => {
    const toMin = t => { const m = t?.match(/(\d+):(\d+)\s*(AM|PM)/i); if (!m) return 0; let h=parseInt(m[1]),min=parseInt(m[2]); if(m[3].toUpperCase()==='PM'&&h!==12)h+=12; if(m[3].toUpperCase()==='AM'&&h===12)h=0; return h*60+min; };
    return toMin(a.time) - toMin(b.time);
  });

  // Build tomorrow's full schedule
  const tomorrowDayName = DAYS[tomorrowDate.getDay()];
  const recurringTomorrow = recurringSchedule[tomorrowDayName] || [];
  const fullTomorrow = [...recurringTomorrow, ...tomorrowSchedule].sort((a, b) => {
    const toMin = t => { const m = t?.match(/(\d+):(\d+)\s*(AM|PM)/i); if (!m) return 0; let h=parseInt(m[1]),min=parseInt(m[2]); if(m[3].toUpperCase()==='PM'&&h!==12)h+=12; if(m[3].toUpperCase()==='AM'&&h===12)h=0; return h*60+min; };
    return toMin(a.time) - toMin(b.time);
  });

  // Canvas deadlines
  let canvasLines = '';
  try {
    const ICAL_URL = process.env.CANVAS_ICAL_URL;
    if (ICAL_URL) {
      const canvasRes = await fetch(ICAL_URL);
      if (canvasRes.ok) {
        const text = await canvasRes.text();
        const now = new Date(todayISO + 'T00:00:00');
        const cutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const events = [];
        const blocks = text.split('BEGIN:VEVENT');
        for (let i = 1; i < blocks.length; i++) {
          const block = blocks[i];
          const get = k => { const m = block.match(new RegExp(`(?:^|\\n)${k}[^:]*:([^\\n]+(?:\\n[ \\t][^\\n]+)*)`, 'm')); return m ? m[1].replace(/\r?\n[ \t]/g,'').trim() : ''; };
          const summary = get('SUMMARY').replace(/\\,/g,',').trim();
          const dtstart = get('DTSTART');
          if (!summary || !dtstart || /^L[\d\s_]/i.test(summary)) continue;
          try {
            const s = dtstart.includes('T') ? dtstart.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/,'$1-$2-$3T$4:$5:$6$7') : dtstart.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')+'T00:00:00Z';
            const date = new Date(s);
            if (!isNaN(date) && date >= now && date <= cutoff) {
              const diff = Math.round((date - now) / (1000*60*60*24));
              const label = summary.replace(/\s*\[[^\]]*\]\s*$/,'').trim();
              events.push(`${label} (due ${diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : `in ${diff}d`})`);
            }
          } catch(e) {}
        }
        if (events.length) canvasLines = 'Canvas this week: ' + events.slice(0,5).join(', ');
      }
    }
  } catch(e) {}

  // Habit summary
  const habitEntries = weekHabits ? Object.entries(weekHabits).sort(([a],[b]) => a.localeCompare(b)) : [];
  let bibleToday = false, gymToday = false, lastBibleDays = null, lastGymDays = null;
  for (const [date, h] of habitEntries) {
    const daysAgo = Math.round((new Date(todayISO) - new Date(date+'T12:00:00')) / (1000*60*60*24));
    if (h.bible && (lastBibleDays === null)) lastBibleDays = daysAgo;
    if (h.gym && (lastGymDays === null)) lastGymDays = daysAgo;
    if (date === todayISO) { bibleToday = h.bible; gymToday = h.gym; }
  }

  // Recurring tasks status
  const urgentTasks = recurringTasks.filter(t => {
    if (!t.lastDone) return true;
    const nextDue = new Date(t.lastDone + 'T12:00:00');
    nextDue.setDate(nextDue.getDate() + (t.frequencyDays || 7));
    const daysUntil = Math.round((nextDue - new Date(todayISO + 'T12:00:00')) / (1000*60*60*24));
    return daysUntil <= 2;
  }).map(t => t.title);

  // Priorities
  const priorityList = priorities?.map(p => p.label).join(', ') || '';

  // Build context string
  const context = [
    `Today: ${todayReadable}. Current time: ${clientTime || 'unknown'}.`,
    fullToday.length ? `Today's schedule: ${fullToday.map(i => `${i.time} ${i.title}`).join(', ')}` : 'No schedule today.',
    fullTomorrow.length ? `Tomorrow: ${fullTomorrow.map(i => `${i.time} ${i.title}`).join(', ')}` : 'Tomorrow looks clear.',
    canvasLines || 'No Canvas deadlines this week.',
    priorityList ? `Focus list: ${priorityList}` : 'No priorities set.',
    `Bible today: ${bibleToday ? 'done' : lastBibleDays !== null ? `last done ${lastBibleDays}d ago` : 'not logged'}. Gym today: ${gymToday ? 'done' : lastGymDays !== null ? `last done ${lastGymDays}d ago` : 'not logged'}.`,
    energy ? `Energy: ${energy}` : '',
    urgentTasks.length ? `Urgent recurring: ${urgentTasks.join(', ')}` : '',
    backlog.length ? `Backlog items: ${backlog.length} waiting` : '',
  ].filter(Boolean).join('\n');

  const systemPrompt = isMorning
    ? `You are Noa, Brooke's personal AI. Generate a morning brief - a tight 4-6 line summary of what Brooke needs to know to start her day. No markdown, no bullet points, no headers. Plain conversational sentences, one per line. Cover: what's on the schedule today, any deadlines coming up, habit status, anything urgent (recurring tasks overdue, etc.), and end with one clear recommendation for what to tackle first. Be warm but efficient. No filler, no "good morning" opener - just the intel. She needs to read this in 10 seconds.`
    : `You are Noa, Brooke's personal AI. Generate an evening recap - a tight 4-6 line summary of where things stand and what to do with the rest of tonight. No markdown, no bullet points, no headers. Plain conversational sentences, one per line. Cover: how today went (habits done or not, schedule complete), what's coming tomorrow, any deadlines in the next 48 hours, and end with one clear recommendation for tonight. Be warm but direct. No filler opener - just the intel.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: context }],
      }),
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const brief = data.content[0].text.trim();
    return res.json({ brief, type: briefType });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
