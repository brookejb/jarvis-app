import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ?reset_memory=1 to wipe and rewrite memory
  if (req.query.reset_memory) {
    const clean = [
      {"fact":"Walking to north campus through the arb takes 50 minutes each way","date":"2026-04-15"},
      {"fact":"North campus is where ME 250 lab, ME 250 lecture, shop reservations, and EECS 314 lab are located","date":"2026-04-15"},
      {"fact":"M Racing Director of Business Subteam role","date":"2026-04-15"},
      {"fact":"Stopped taking Zyrtec in early April 2026 - energy returning to baseline","date":"2026-04-15"},
      {"fact":"More productive on days that start with morning movement","date":"2026-04-15"},
      {"fact":"Long walks regulate stress and clear her head","date":"2026-04-15"},
      {"fact":"Ross application submitted and complete","date":"2026-04-01"},
      {"fact":"ME 250 prelab timing is provided after shop sessions on north campus","date":"2026-04-15"}
    ];
    await kv.set('noa_memory', clean);
    return res.json({ ok: true, count: clean.length });
  }

  const today = new Date().toLocaleDateString('en-CA');

  // Read the next 7 days of specific schedules
  const dates = [];
  for (let i = -1; i <= 7; i++) {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() + i);
    dates.push(d.toLocaleDateString('en-CA'));
  }

  const [recurring, memory, backlog, recurringTasks, ...daySchedules] = await Promise.all([
    kv.get('noa_recurring_schedule').catch(() => null),
    kv.get('noa_memory').catch(() => null),
    kv.get('noa_backlog').catch(() => null),
    kv.get('noa_recurring_tasks').catch(() => null),
    ...dates.map(d => kv.get(`noa_schedule_${d}`).catch(() => null)),
  ]);

  const specificDays = {};
  dates.forEach((d, i) => { if (daySchedules[i]) specificDays[d] = daySchedules[i]; });

  res.json({
    today,
    recurring_schedule: recurring || {},
    specific_days: specificDays,
    memory_facts: memory || [],
    backlog: backlog || [],
    recurring_tasks: recurringTasks || [],
  });
}
