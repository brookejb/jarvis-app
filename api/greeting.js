import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();
const MEMORY_KEY = 'noa_memory';

// Minimal iCal parser to get upcoming deadlines for context
function parseUpcomingFromIcal(text, days = 7) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = (key) => {
      const m = block.match(new RegExp(`(?:^|\\n)${key}[^:]*:([^\\n]+(?:\\n[ \\t][^\\n]+)*)`, 'm'));
      return m ? m[1].replace(/\r?\n[ \t]/g, '').trim() : '';
    };
    const summary = get('SUMMARY').replace(/\\,/g, ',').trim();
    const dtstart = get('DTSTART');
    if (!summary || !dtstart) continue;

    let date;
    try {
      const s = dtstart.includes('T')
        ? dtstart.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/, '$1-$2-$3T$4:$5:$6$7')
        : dtstart.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T00:00:00';
      date = new Date(s);
      if (isNaN(date)) continue;
    } catch (e) { continue; }

    if (date >= now && date <= cutoff) {
      const diffDays = Math.round((date - now) / (1000 * 60 * 60 * 24));
      const due = diffDays === 0 ? 'today' : diffDays === 1 ? 'tomorrow' : `${date.toLocaleDateString('en-US', { weekday: 'short' })}`;
      // Skip lectures (L_ prefix)
      if (!/^L[\d\s_]/i.test(summary)) {
        events.push({ summary, due, urgency: diffDays });
      }
    }
  }
  return events.sort((a, b) => a.urgency - b.urgency).slice(0, 5);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];
  const todayReadable = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  // Load memory
  let memoryFacts = [];
  try { memoryFacts = await kv.get(MEMORY_KEY) || []; } catch (e) {}

  // Load today's schedule
  let schedule = [];
  try { schedule = await kv.get(`noa_schedule_${todayISO}`) || []; } catch (e) {}

  // Load Canvas deadlines
  let canvasDeadlines = [];
  try {
    const ICAL_URL = process.env.CANVAS_ICAL_URL;
    if (ICAL_URL) {
      const icalRes = await fetch(ICAL_URL);
      if (icalRes.ok) {
        const text = await icalRes.text();
        canvasDeadlines = parseUpcomingFromIcal(text, 7);
      }
    }
  } catch (e) {}

  // Build context blocks
  const memoryBlock = memoryFacts.length > 0
    ? `\nWhat you know about Brooke:\n${memoryFacts.map(f => `- ${f}`).join('\n')}`
    : '';

  const scheduleBlock = schedule.length > 0
    ? `\nToday's schedule: ${schedule.map(s => `${s.time} ${s.title}`).join(', ')}`
    : '';

  const canvasBlock = canvasDeadlines.length > 0
    ? `\nUpcoming Canvas deadlines: ${canvasDeadlines.map(d => `${d.summary} (due ${d.due})`).join(', ')}`
    : '';

  const systemPrompt = `You are Noa, Brooke's personal AI planning partner. Sharp, warm, direct. Never generic.

Today is ${todayReadable} (${timeOfDay}).${memoryBlock}${scheduleBlock}${canvasBlock}

Write a 2-3 sentence proactive opening for Brooke. Rules:
- Lead with the most urgent or important thing right now — a specific deadline, a gap in her week, something time-sensitive. Name it directly.
- If she has Canvas deadlines soon, mention the most pressing one by name.
- If her schedule today is heavy or light, acknowledge it.
- Close with one short orienting statement or soft question — not "how are you feeling" filler, but something that moves her forward.
- Never use em dashes. Use commas or hyphens.
- No "Good morning!" as a standalone opener. Weave time-of-day in naturally or skip it.
- Sound like you already know her, because you do.

Bad example: "Good morning! Hope you're feeling great. What would you like to work on today?"
Good example: "You've got an EECS problem set due Thursday and nothing scheduled for it yet — that's the gap to close today. Bible's at zero this week too if that matters to you."`;

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
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Morning.' }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    res.json({ greeting: data.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
