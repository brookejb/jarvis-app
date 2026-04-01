import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

export const BACKLOG_KEY = 'noa_backlog';
export const RECURRING_TASKS_KEY = 'noa_recurring_tasks';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [backlog, recurringTasks] = await Promise.all([
      kv.get(BACKLOG_KEY).then(v => v || []).catch(() => []),
      kv.get(RECURRING_TASKS_KEY).then(v => v || []).catch(() => []),
    ]);

    // Compute next-due date for each recurring task
    const today = new Date();
    const enriched = recurringTasks.map(task => {
      let nextDue = null;
      if (task.lastDone) {
        const last = new Date(task.lastDone + 'T12:00:00');
        const target = new Date(last.getTime() + task.frequencyDays * 24 * 60 * 60 * 1000);
        const earliest = new Date(Math.max(
          today.getTime(),
          last.getTime() + 3 * 24 * 60 * 60 * 1000 // never within 3 days of last done
        ));
        nextDue = target < earliest ? earliest.toISOString().split('T')[0] : target.toISOString().split('T')[0];
      }
      return { ...task, nextDue };
    }).sort((a, b) => {
      if (!a.nextDue) return 1;
      if (!b.nextDue) return -1;
      return a.nextDue.localeCompare(b.nextDue);
    });

    res.json({ backlog, recurringTasks: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
