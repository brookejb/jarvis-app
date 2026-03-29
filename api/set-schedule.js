import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

// Manual schedule seeder - POST { date: "YYYY-MM-DD", items: [...] }
// Used to fix schedules that didn't sync properly through chat
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { date, items } = req.body;
  if (!date || !Array.isArray(items)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) and items array required' });
  }

  try {
    await kv.set(`noa_schedule_${date}`, items);
    res.json({ ok: true, date, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
