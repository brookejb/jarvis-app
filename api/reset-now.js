import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
  return res.json({ ok: true, count: clean.length, facts: clean });
}
