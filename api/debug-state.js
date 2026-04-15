import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST to reset memory
  if (req.method === 'POST' && req.body?.reset_memory) {
    await kv.set('noa_memory', req.body.facts || []);
    return res.json({ ok: true, count: (req.body.facts || []).length });
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
