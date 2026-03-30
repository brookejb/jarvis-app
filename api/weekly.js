import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();
const MEMORY_KEY = 'noa_memory';
const RECURRING_KEY = 'noa_recurring_schedule';
const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  let memoryFacts = [];
  try {
    memoryFacts = await kv.get(MEMORY_KEY) || [];
  } catch (e) {}

  const memoryBlock = memoryFacts.length > 0
    ? `\nWhat you know about Brooke:\n${memoryFacts.map(f => `- ${f}`).join('\n')}`
    : '';

  const systemPrompt = `You are Noa, Brooke's personal AI planning partner. Today is ${today}.${memoryBlock}

Return a JSON object with this exact structure - no other text, just valid JSON:
{
  "insight": "One punchy sentence about this week. Be specific. No em dashes. Use a comma or hyphen instead.",
  "insightDetail": "One sentence of supporting context. Be concrete.",
  "deadlines": [
    { "title": "Task name", "due": "Due Mon", "category": "Academic", "color": "blue" }
  ]
}

Color options: blue (Academic), orange (Racing), green (Movement), pink (Personal/Faith), purple (Other).
Include only deadlines you actually know about from memory. Max 5. If you know nothing specific, return an empty deadlines array.`;

  // Load schedule for the requested date from Redis, merged with recurring classes
  const requestedDate = req.query.date || new Date().toISOString().split('T')[0];
  let schedule = [];
  try {
    const oneOff = await kv.get(`noa_schedule_${requestedDate}`) || [];
    const recurring = await kv.get(RECURRING_KEY) || {};
    const dayOfWeek = DAYS[new Date(requestedDate + 'T12:00:00').getDay()];
    const recurringToday = recurring[dayOfWeek] || [];
    // Merge: recurring classes as base, one-off events on top, sort by time
    const all = [...recurringToday, ...oneOff];
    const toMins = (t) => {
      const m = (t || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!m) return 9999;
      let h = parseInt(m[1]), min = parseInt(m[2]);
      if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
      if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
      return h * 60 + min;
    };
    schedule = all.sort((a, b) => toMins(a.time) - toMins(b.time));
  } catch (e) {}

  // Schedule is always returned regardless of whether Claude succeeds
  let insight = '';
  let insightDetail = '';
  let deadlines = [];

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
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Weekly overview.' }],
      }),
    });

    const data = await response.json();
    if (!data.error) {
      const text = data.content[0].text.trim();
      // Strip any markdown code fences Claude might add
      const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      insight = parsed.insight || '';
      insightDetail = parsed.insightDetail || '';
      deadlines = parsed.deadlines || [];
    }
  } catch (err) {
    // Claude failed - still return schedule below
  }

  res.json({ insight, insightDetail, deadlines, schedule });
}
