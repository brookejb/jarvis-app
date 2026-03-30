// Canvas iCal feed parser
// Fetches from CANVAS_ICAL_URL env var, groups by assignment type, returns next 14 days

function parseIcal(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = (key) => {
      const re = new RegExp(`(?:^|\\n)${key}[^:]*:([^\\n]+(?:\\n[ \\t][^\\n]+)*)`, 'm');
      const m = block.match(re);
      return m ? m[1].replace(/\r?\n[ \t]/g, '').trim() : '';
    };

    const summary = get('SUMMARY').replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
    const dtstart = get('DTSTART');
    const url = get('URL');
    if (!summary || !dtstart) continue;

    // Parse iCal datetime: 20260401T040000Z or 20260401
    let date;
    try {
      if (dtstart.includes('T')) {
        const s = dtstart.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/, '$1-$2-$3T$4:$5:$6$7');
        date = new Date(s);
      } else {
        const s = dtstart.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
        date = new Date(s + 'T00:00:00');
      }
      if (isNaN(date)) continue;
    } catch (e) { continue; }

    events.push({ summary, date, url });
  }
  return events.sort((a, b) => a.date - b.date);
}

function formatDue(date) {
  const now = new Date();
  const diffDays = Math.round((date - now) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  if (diffDays < 7) return `Due ${date.toLocaleDateString('en-US', { weekday: 'short' })}`;
  return `Due ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function classify(summary) {
  const s = summary.trim();
  if (/^L[\d\s_]/i.test(s)) return 'lecture';
  if (/^M[\d\s_]/i.test(s)) return 'module';
  if (/^P[\d\s_]/i.test(s)) return 'homework';
  return 'other';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ICAL_URL = process.env.CANVAS_ICAL_URL;
  if (!ICAL_URL) return res.status(500).json({ error: 'CANVAS_ICAL_URL not set' });

  try {
    const response = await fetch(ICAL_URL);
    if (!response.ok) return res.status(502).json({ error: 'Canvas feed unavailable' });
    const text = await response.text();

    const all = parseIcal(text);

    // Filter to next 14 days, skip past events
    const now = new Date();
    const cutoff = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const upcoming = all.filter(e => e.date >= now && e.date <= cutoff);

    const lectures  = upcoming.filter(e => classify(e.summary) === 'lecture');
    const modules   = upcoming.filter(e => classify(e.summary) === 'module');
    const homeworks = upcoming.filter(e => classify(e.summary) === 'homework');
    const other     = upcoming.filter(e => classify(e.summary) === 'other');

    const deadlines = [];

    // Individual homework/problem set items — most important
    for (const hw of homeworks) {
      deadlines.push({
        title: hw.summary,
        due: formatDue(hw.date),
        dueDate: hw.date.toISOString(),
        category: 'Academic',
        color: 'blue',
        type: 'homework',
        url: hw.url,
      });
    }

    // Other individual assignments
    for (const item of other) {
      deadlines.push({
        title: item.summary,
        due: formatDue(item.date),
        dueDate: item.date.toISOString(),
        category: 'Academic',
        color: 'blue',
        type: 'assignment',
        url: item.url,
      });
    }

    // Modules — group into one card with count + next due
    if (modules.length > 0) {
      deadlines.push({
        title: `${modules.length} module${modules.length > 1 ? 's' : ''} due`,
        due: formatDue(modules[0].date),
        dueDate: modules[0].date.toISOString(),
        category: 'Academic',
        color: 'purple',
        type: 'modules',
        items: modules.map(m => ({ title: m.summary, due: formatDue(m.date) })),
      });
    }

    // Lectures — grouped, low priority
    if (lectures.length > 0) {
      deadlines.push({
        title: `${lectures.length} lecture${lectures.length > 1 ? 's' : ''} this week`,
        due: formatDue(lectures[0].date),
        dueDate: lectures[0].date.toISOString(),
        category: 'Academic',
        color: 'purple',
        type: 'lectures',
        items: lectures.map(l => ({ title: l.summary, due: formatDue(l.date) })),
      });
    }

    // Sort everything by due date
    deadlines.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    res.json({
      deadlines,
      counts: { homeworks: homeworks.length, modules: modules.length, lectures: lectures.length, other: other.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
