import { kv } from '@vercel/kv';

const MEMORY_KEY = 'noa_memory';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const memory = await kv.get(MEMORY_KEY) || [];
    return res.json({ facts: memory });
  }

  if (req.method === 'POST') {
    const { facts } = req.body;
    if (!facts || !Array.isArray(facts)) {
      return res.status(400).json({ error: 'facts array required' });
    }
    const existing = await kv.get(MEMORY_KEY) || [];
    const updated = [...new Set([...existing, ...facts])].slice(-100);
    await kv.set(MEMORY_KEY, updated);
    return res.json({ ok: true, count: updated.length });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
