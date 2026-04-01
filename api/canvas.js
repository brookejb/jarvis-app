// Canvas iCal feed parser
// Extracts course info per event, assigns stable colors per course

const COURSE_PALETTE = [
  '#5092eb', // blue
  '#F0607A', // pink
  '#7DD4B0', // green
  '#E87D4A', // orange
  '#c3a6ff', // purple
  '#FFB347', // amber
  '#87CEEB', // sky
  '#DDA0DD', // plum
];

const courseColorMap = {};
let colorIdx = 0;

function courseColor(courseId) {
  if (!courseColorMap[courseId]) {
    courseColorMap[courseId] = COURSE_PALETTE[colorIdx % COURSE_PALETTE.length];
    colorIdx++;
  }
  return courseColorMap[courseId];
}

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
    const description = get('DESCRIPTION').replace(/\\n/g, '\n').replace(/\\,/g, ',');
    if (!summary || !dtstart) continue;

    // Extract course ID from URL: /courses/123456/
    const courseIdMatch = url.match(/\/courses\/(\d+)\//);
    const courseId = courseIdMatch ? courseIdMatch[1] : 'other';

    // Try to get course name from description
    let courseName = '';
    const courseNameMatch = description.match(/(?:Course:|class:)\s*([^\n\\]+)/i);
    if (courseNameMatch) {
      courseName = courseNameMatch[1].trim();
    }
    // Fallback: infer from URL structure or leave blank
    if (!courseName && courseId !== 'other') {
      courseName = `Course ${courseId}`;
    }

    // Parse iCal datetime
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

    events.push({ summary, date, url, courseId, courseName });
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
    const now = new Date();

    // ?all=1 returns full semester grouped by course for goal task population
    if (req.query.all === '1') {
      const byCourse = {};

      for (const e of all) {
        // Always group by Canvas course ID from URL — it's stable and always present
        const key = e.courseId;
        if (!byCourse[key]) byCourse[key] = { code: null, courseId: e.courseId, assignments: [] };

        // Extract best course code from summary for display name
        // Canvas format: "Assignment name [DEPT 314 001 WN 2026]"
        if (!byCourse[key].code) {
          const bracketMatch = e.summary.match(/\[([A-Z]{2,10}\s+\d{3}[A-Z]?)\s/);
          const inlineMatch = e.summary.match(/\b([A-Z]{2,10}\s+\d{3}[A-Z]?)\b/);
          byCourse[key].code = bracketMatch?.[1]?.trim() || inlineMatch?.[1]?.trim() || null;
        }

        // Skip pure lecture/section entries
        if (/^(L|Lec|Lecture)[\d\s_]/i.test(e.summary)) continue;

        const label = e.summary.replace(/\s*\[[^\]]*\]\s*/g, '').trim() || e.summary;
        byCourse[key].assignments.push({
          label,
          dueDate: e.date.toISOString(),
          done: e.date < now,
        });
      }

      // Sort assignments within each course by due date, set fallback name
      const courses = Object.values(byCourse)
        .filter(c => c.assignments.length > 0)
        .map(c => ({ ...c, code: c.code || `Course ${c.courseId}` }))
        .sort((a, b) => a.code.localeCompare(b.code));

      courses.forEach(c => c.assignments.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)));

      return res.json({ courses });
    }

    // Filter to next 30 days for calendar view
    const cutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcoming = all.filter(e => e.date >= now && e.date <= cutoff);

    // Assign stable colors per course
    const courseMeta = {};
    for (const e of upcoming) {
      if (!courseMeta[e.courseId]) {
        courseMeta[e.courseId] = {
          color: courseColor(e.courseId),
          name: e.courseName,
        };
      }
    }

    const lectures  = upcoming.filter(e => classify(e.summary) === 'lecture');
    const modules   = upcoming.filter(e => classify(e.summary) === 'module');
    const homeworks = upcoming.filter(e => classify(e.summary) === 'homework');
    const other     = upcoming.filter(e => classify(e.summary) === 'other');

    // Build full item list (for calendar, include all individual items with course color)
    const allItems = upcoming.map(e => ({
      title: e.summary,
      due: formatDue(e.date),
      dueDate: e.date.toISOString(),
      courseId: e.courseId,
      courseName: e.courseName,
      courseColor: courseMeta[e.courseId]?.color || '#5092eb',
      type: classify(e.summary),
      url: e.url,
    }));

    // Build grouped deadlines (for weekly page strip)
    const deadlines = [];

    for (const hw of homeworks) {
      const color = courseMeta[hw.courseId]?.color || '#5092eb';
      deadlines.push({ title: hw.summary, due: formatDue(hw.date), dueDate: hw.date.toISOString(), courseColor: color, courseName: hw.courseName, type: 'homework', url: hw.url });
    }
    for (const item of other) {
      const color = courseMeta[item.courseId]?.color || '#5092eb';
      deadlines.push({ title: item.summary, due: formatDue(item.date), dueDate: item.date.toISOString(), courseColor: color, courseName: item.courseName, type: 'assignment', url: item.url });
    }
    if (modules.length > 0) {
      const color = courseMeta[modules[0].courseId]?.color || '#c3a6ff';
      deadlines.push({ title: `${modules.length} module${modules.length > 1 ? 's' : ''} due`, due: formatDue(modules[0].date), dueDate: modules[0].date.toISOString(), courseColor: color, type: 'modules', items: modules.map(m => ({ title: m.summary, due: formatDue(m.date) })) });
    }
    if (lectures.length > 0) {
      const color = courseMeta[lectures[0].courseId]?.color || '#c3a6ff';
      deadlines.push({ title: `${lectures.length} lecture${lectures.length > 1 ? 's' : ''}`, due: formatDue(lectures[0].date), dueDate: lectures[0].date.toISOString(), courseColor: color, type: 'lectures' });
    }

    deadlines.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    res.json({ deadlines, allItems, courses: Object.entries(courseMeta).map(([id, m]) => ({ id, ...m })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
