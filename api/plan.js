import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const RECURRING_KEY = 'noa_recurring_schedule';
const MEMORY_KEY = 'noa_memory';
const PLAN_META_KEY = 'noa_plan_meta';
const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function localDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function parseCanvasForPlan(text, fromDate, days = 14) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  const cutoff = new Date(fromDate.getTime() + days * 24 * 60 * 60 * 1000);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = (key) => {
      const m = block.match(new RegExp(`(?:^|\\n)${key}[^:]*:([^\\n]+(?:\\n[ \\t][^\\n]+)*)`, 'm'));
      return m ? m[1].replace(/\r?\n[ \t]/g, '').trim() : '';
    };
    const summary = get('SUMMARY').replace(/\\,/g, ',').trim();
    const dtstart = get('DTSTART');
    if (!summary || !dtstart) continue;
    if (/^L[\d\s_]/i.test(summary)) continue;

    let date;
    try {
      const s = dtstart.includes('T')
        ? dtstart.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/, '$1-$2-$3T$4:$5:$6$7')
        : dtstart.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T12:00:00';
      date = new Date(s);
      if (isNaN(date)) continue;
    } catch(e) { continue; }

    if (date < fromDate || date > cutoff) continue;

    const codeMatch = summary.match(/\b([A-Z]{2,8}\s*\d{3,4})\b/);
    const courseCode = codeMatch ? codeMatch[1] : '';
    const cleanTitle = summary.replace(/^[LMPp][\d_\s]+[-:]?\s*/i, '').trim() || summary;
    const daysUntil = Math.ceil((date - fromDate) / (1000 * 60 * 60 * 24));

    events.push({ title: cleanTitle, courseCode, dueDate: localDateStr(date), daysUntil });
  }
  return events.sort((a, b) => a.daysUntil - b.daysUntil);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No API key' });

  const force = req.query.force === '1';
  const clientDate = req.query.date || new Date().toISOString().split('T')[0];
  const fromDate = new Date(clientDate + 'T00:00:00');

  // Cache: only re-plan if >8 hours old or forced
  if (!force) {
    try {
      const meta = await kv.get(PLAN_META_KEY);
      if (meta?.generatedAt) {
        const ageHours = (Date.now() - new Date(meta.generatedAt).getTime()) / (1000 * 60 * 60);
        if (ageHours < 8) return res.json({ status: 'cached', generatedAt: meta.generatedAt });
      }
    } catch(e) {}
  }

  // Load inputs in parallel
  let recurring = {}, memoryFacts = [], canvasDeadlines = [];
  try {
    [recurring, memoryFacts] = await Promise.all([
      kv.get(RECURRING_KEY).then(v => v || {}).catch(() => ({})),
      kv.get(MEMORY_KEY).then(v => v || []).catch(() => []),
    ]);
  } catch(e) {}

  try {
    const ICAL_URL = process.env.CANVAS_ICAL_URL;
    if (ICAL_URL) {
      const r = await fetch(ICAL_URL);
      if (r.ok) canvasDeadlines = parseCanvasForPlan(await r.text(), fromDate, 14);
    }
  } catch(e) {}

  // Build date range
  const dateRange = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(fromDate);
    d.setDate(fromDate.getDate() + i);
    dateRange.push({ iso: localDateStr(d), day: DAYS[d.getDay()], label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) });
  }

  const classSchedule = DAYS.map(day => {
    const items = recurring[day] || [];
    return items.length ? `  ${day.charAt(0).toUpperCase()+day.slice(1)}: ${items.map(i => `${i.time} ${i.title}`).join(', ')}` : null;
  }).filter(Boolean).join('\n') || '  (No class schedule saved yet - Brooke needs to tell Noa her schedule)';

  const deadlinesList = canvasDeadlines.length > 0
    ? canvasDeadlines.slice(0, 20).map(d => `  - "${d.title}"${d.courseCode ? ` (${d.courseCode})` : ''} due ${d.dueDate} — ${d.daysUntil} days away`).join('\n')
    : '  (No upcoming Canvas deadlines found)';

  const systemPrompt = `You are Noa, Brooke's AI planning engine. Generate an optimized 14-day schedule as JSON.

BROOKE'S PROFILE:
- UMich ME + Ross dual degree junior. M Racing Business Director candidate.
- Peak focus window: 9PM-midnight. Mornings are lighter but workable.
- Bible reading: daily anchor, 15-20 min, ideally morning (8-9AM)
- Gym: 3-4x/week (green blocks). Spread out, avoid stacking with heavy academic days.
- Recovering from a car crash — don't pack every hour. Leave breathing room.
- Deadline-driven by nature — needs study blocks built in early so she's not always cramming.

RECURRING CLASSES (always include these exactly, never move them):
${classSchedule}

UPCOMING CANVAS DEADLINES:
${deadlinesList}

PLANNING RULES:
1. Always include recurring classes first. Same time, same title, color blue.
2. Study blocks before deadlines:
   - Due in 1-2 days: 2hr block the day before, labeled with deadline
   - Due in 3-5 days: 1hr block, 2 days before
   - Exam/big deliverable: 2-3hr block 2-3 days before, and a lighter 1hr review the day before
3. Deep work study sessions: schedule 9:00 PM for hard STEM work (EECS, Thermo problem sets)
4. Bible blocks: 8:00 AM, color pink, 3-4 days/week minimum
5. Gym blocks: 1hr, color green, 3x/week. Spread them out.
6. M Racing: if there's no class heavy day, add a 1hr "M Racing Work" block (orange) 2-3x/week
7. Max 5-6 items per day total. Don't fill every slot — margin matters.
8. Use "note" field to briefly explain why a block is there: "Problem set due Wed", "Exam Friday"

COLORS: blue=class/academic, orange=racing, green=gym, pink=Bible/faith, purple=other

Return ONLY valid JSON. No explanation, no markdown fences. Just the JSON object:
{
  "YYYY-MM-DD": [
    {"time": "H:MM AM", "title": "Event", "color": "blue", "note": "optional"}
  ]
}

Plan these exact dates: ${dateRange.map(d => `${d.iso} (${d.label})`).join(', ')}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Generate the 14-day plan now.' }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content[0].text.trim();
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const plan = JSON.parse(cleaned);

    // Save each day's plan to Redis
    const saves = Object.entries(plan)
      .filter(([, items]) => Array.isArray(items) && items.length > 0)
      .map(([date, items]) => kv.set(`noa_schedule_${date}`, items));
    await Promise.all(saves);

    const generatedAt = new Date().toISOString();
    await kv.set(PLAN_META_KEY, { generatedAt, daysPlanned: Object.keys(plan).length });

    res.json({ status: 'planned', generatedAt, daysPlanned: Object.keys(plan).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
