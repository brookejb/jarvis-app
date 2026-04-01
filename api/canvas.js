// Canvas iCal feed parser
// Extracts course info per event, assigns stable colors per course

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CANVAS_CACHE_KEY = 'noa_canvas_cache';

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

// Extract course code from summary string
function extractCourseCode(summary) {
  // Primary: bracket format "[EECS 314 001 WN 2026]" → "EECS 314"
  const bracketContent = summary.match(/\[([^\]]+)\]/);
  if (bracketContent) {
    const codeMatch = bracketContent[1].match(/^([A-Z]{2,10}\s+\d{3}[A-Z]?)/);
    if (codeMatch) return codeMatch[1].trim();
  }
  // Fallback: course code inline in summary
  const inline = summary.match(/\b([A-Z]{2,10}\s+\d{3}[A-Z]?)\b/);
  if (inline) return inline[1].trim();
  return null;
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

      // --- Redis accumulation cache ---
      // Canvas iCal feeds often only return a rolling window (e.g. current month forward).
      // We cache every assignment we've ever seen in Redis so past months accumulate.

      // Load existing cache
      let cachedEvents = [];
      try {
        cachedEvents = (await kv.get(CANVAS_CACHE_KEY)) || [];
      } catch (e) { /* cache miss is fine */ }

      // Build a dedup map from cache first (older data)
      // Key: URL (includes Canvas assignment ID) or summary|dateISO fallback
      const eventMap = new Map();
      for (const ev of cachedEvents) {
        const key = ev.url || `${ev.summary}|${ev.dateISO}`;
        eventMap.set(key, ev);
      }

      // Merge in current iCal events (overwrite with freshest data)
      const freshFiltered = all.filter(e => !/^(L|Lec|Lecture)[\d\s_]/i.test(e.summary));
      for (const e of freshFiltered) {
        const key = e.url || `${e.summary}|${e.date.toISOString()}`;
        eventMap.set(key, {
          summary: e.summary,
          dateISO: e.date.toISOString(),
          url: e.url,
          courseId: e.courseId,
        });
      }

      // Persist merged cache back to Redis (fire and forget)
      const mergedArr = Array.from(eventMap.values());
      kv.set(CANVAS_CACHE_KEY, mergedArr).catch(() => {});

      // --- Build course groups from merged events ---
      const byCourse = {};

      for (const ev of mergedArr) {
        const { summary, dateISO, url, courseId } = ev;
        const date = new Date(dateISO);
        if (!summary || isNaN(date)) continue;

        const courseCode = extractCourseCode(summary);
        const key = courseCode || courseId || 'other';

        if (!byCourse[key]) {
          byCourse[key] = {
            code: courseCode || (courseId && courseId !== 'other' ? `Course ${courseId}` : 'Other'),
            assignments: [],
          };
        }

        // Strip bracket suffix for clean label: "HW 3 [EECS 314 001 WN 2026]" → "HW 3"
        const label = summary.replace(/\s*\[[^\]]*\]\s*$/, '').trim() || summary;

        byCourse[key].assignments.push({
          label,
          dueDate: dateISO,
          done: date < now,
        });
      }

      // Sort courses alphabetically, sort assignments within each by due date
      const courses = Object.values(byCourse)
        .filter(c => c.assignments.length > 0)
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
