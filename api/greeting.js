import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();
const MEMORY_KEY = 'noa_memory';

// Minimal iCal parser to get upcoming deadlines for context
function parseUpcomingFromIcal(text, days = 7, clientNow = new Date()) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  const now = clientNow;
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

  // Use client's local date — same fix as chat.js to avoid UTC drift after ~8pm ET
  const todayISO = req.query.date || new Date().toISOString().split('T')[0];
  const todayReadable = new Date(todayISO + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  // Use client hour if provided, otherwise fall back to server hour
  const clientHour = req.query.hour ? parseInt(req.query.hour, 10) : new Date().getHours();
  const timeOfDay = clientHour < 12 ? 'morning' : clientHour < 17 ? 'afternoon' : 'evening';
  // Treat "now" as midnight of the client's date so iCal day-diff math is correct
  const clientNow = new Date(todayISO + 'T00:00:00Z');

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
        canvasDeadlines = parseUpcomingFromIcal(text, 7, clientNow);
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

  const mode = req.query.mode || 'student';

  const MODE_INSTRUCTIONS = {
    student: {
      tone: `Tone: Direct, urgent, information-dense. Every word earns its place. She's in heads-down academic mode.`,
      lead: `Lead with: The most pressing academic deadline, then her next available deep work window. If she has Canvas items due soon, name them. If her schedule is clear for studying, say so - that's an asset.`,
      feel: `Feel: A sharp planner who respects her time. Zero fluff. Dense and actionable.`,
    },
    racing: {
      tone: `Tone: Operational, energetic. This is a morning team briefing, not a check-in.`,
      lead: `Lead with: Outstanding M Racing tasks, the next team meeting or Wilson Center session, where the business wing stands. Don't mention academic assignments unless they're about to conflict with racing.`,
      feel: `Feel: A capable co-director giving her the brief before she walks in. Collaborative, forward-moving.`,
    },
    builder: {
      tone: `Tone: Ambitious, spacious, long-horizon. Give her room to think.`,
      lead: `Lead with: What she's building toward this week - Ross application, team website, any long-arc project. Reference the Sydney vision if relevant. Not today's to-do list - the arc.`,
      feel: `Feel: Zooming out to 30,000 feet. Remind her of what she's constructing and why it matters. Ambitious and grounding at the same time.`,
    },
    personal: {
      tone: `Tone: Calm, quiet, soft. This is not a productivity check-in. Do not mention deadlines or tasks.`,
      lead: `Lead with: Her Sydney vision, Bible streak this week, gym sessions, morning routine. How she's tracking as a person, not as a student.`,
      feel: `Feel: Exhaling. She comes to this mode to reconnect with who she is, not what she has to do. Warm, grounding, no urgency. This should feel like a breath, not a briefing.`,
    },
  };

  const modeInstr = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.student;

  const systemPrompt = `You are Noa, Brooke's personal AI planning partner. You know her well.

Today is ${todayReadable} (${timeOfDay}).${memoryBlock}${scheduleBlock}${canvasBlock}

${modeInstr.tone}
${modeInstr.lead}
${modeInstr.feel}

Write 2-3 sentences max. Never use em dashes - use commas or hyphens. No standalone "Good morning!" opener. Sound like you already know her, because you do. No filler, no generic affirmations.`;

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
