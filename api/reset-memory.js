import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { facts } = req.body;
  if (!Array.isArray(facts)) return res.status(400).json({ error: 'facts array required' });

  await kv.set('noa_memory', facts);
  return res.json({ ok: true, count: facts.length });
}
