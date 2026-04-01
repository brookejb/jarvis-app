import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const MEMORY_KEY = 'noa_memory';
const RECURRING_KEY = 'noa_recurring_schedule';
const BACKLOG_KEY = 'noa_backlog';
const RECURRING_TASKS_KEY = 'noa_recurring_tasks';

// Load live Canvas deadlines from iCal for Noa's chat context
async function loadCanvasForChat(todayISO) {
  try {
    const ICAL_URL = process.env.CANVAS_ICAL_URL;
    if (!ICAL_URL) return { block: '', courses: [] };

    const res = await fetch(ICAL_URL);
    if (!res.ok) return { block: '', courses: [] };
    const text = await res.text();

    const now = new Date(todayISO + 'T00:00:00Z');
    const cutoff = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const events = [];
    const blocks = text.split('BEGIN:VEVENT');
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const get = (key) => {
        const m = block.match(new RegExp(`(?:^|\\n)${key}[^:]*:([^\\n]+(?:\\n[ \\t][^\\n]+)*)`, 'm'));
        return m ? m[1].replace(/\r?\n[ \t]/g, '').trim() : '';
      };
      const summary = get('SUMMARY').replace(/\\,/g, ',').trim();
      const dtstart = get('DTSTART');
      const url = get('URL');
      if (!summary || !dtstart) continue;
      if (/^L[\d\s_]/i.test(summary)) continue; // skip lectures

      let date;
      try {
        const s = dtstart.includes('T')
          ? dtstart.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/, '$1-$2-$3T$4:$5:$6$7')
          : dtstart.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T00:00:00Z';
        date = new Date(s);
        if (isNaN(date)) continue;
      } catch(e) { continue; }

      if (date < now || date > cutoff) continue;

      // Try to extract course code from summary (e.g. "EECS 314", "ME 335")
      const codeMatch = summary.match(/\b([A-Z]{2,8}\s*\d{3,4})\b/);
      const courseCode = codeMatch ? codeMatch[1].replace(/\s+/, ' ') : null;

      // Stable course grouping via Canvas URL course ID
      const urlMatch = url.match(/\/courses\/(\d+)\//);
      const canvasCourseId = urlMatch ? urlMatch[1] : 'other';

      const diffDays = Math.round((date - now) / (1000 * 60 * 60 * 24));
      const dueStr = diffDays === 0 ? 'today' : diffDays === 1 ? 'tomorrow'
        : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      events.push({ summary, dueStr, courseCode, canvasCourseId });
    }

    if (!events.length) return { block: '', courses: [] };

    // Group by canvas course
    const byCourse = {};
    for (const e of events) {
      if (!byCourse[e.canvasCourseId]) byCourse[e.canvasCourseId] = { code: e.courseCode, items: [] };
      else if (!byCourse[e.canvasCourseId].code && e.courseCode) byCourse[e.canvasCourseId].code = e.courseCode;
      byCourse[e.canvasCourseId].items.push(`${e.summary} (due ${e.dueStr})`);
    }

    const courses = Object.values(byCourse).filter(c => c.code).map(c => c.code);
    const lines = Object.values(byCourse).map(c =>
      `- ${c.code || 'Other'}: ${c.items.slice(0, 4).join(' | ')}`
    );

    return {
      block: `\n\nLive Canvas deadlines (next 14 days):\n${lines.join('\n')}`,
      courses,
    };
  } catch(e) {
    return { block: '', courses: [] };
  }
}

const BASE_SYSTEM = `You are Noa, Brooke's personal AI planning partner. You are warm, direct, and sharp - never generic, never fluffy.

About Brooke:
- Junior at University of Michigan studying Mechanical Engineering + Ross School of Business (dual degree)
- On M Racing (Formula SAE) as Director of Business Subteam candidate
- Deep faith - Bible reading is a daily anchor, not a checkbox
- Recovering from a car crash - energy management matters
- Peak focus: late night (11PM). Morning energy varies.
- Five-year vision: Sydney, Australia. Every daily decision connects to that.
- Gym sessions and Bible reading are tracked habits she cares about

Your role:
- Help Brooke plan her day, prioritize tasks, and stay on track
- Reference her actual goals and deadlines when relevant
- Be honest - if she's avoiding something, name it
- Keep responses concise and conversational - this is a chat interface, not an essay
- Never track food, body image, or anything related to eating
- Grace over guilt always - if she missed something, move forward not backward
- You can be witty but never at her expense
- Never use em dashes (—) in your responses. Use a comma, period, or hyphen instead.

When she asks what's due or what to focus on, give her a direct answer with a clear recommendation.

MEMORY RULE - NON-NEGOTIABLE:
Any time Brooke tells you a concrete fact (exam date, deadline, preference, life update, habit, goal), you MUST save it immediately - even if you are also asking follow-up questions. Add this block at the very end of your response, after everything else:
[MEMORY]{"facts":["concise fact 1","concise fact 2"]}[/MEMORY]

Examples:
- She says "my thermo exam is tuesday" -> save "ME 335 Thermo exam is on Tuesday"
- She says "I have a meeting thursday" -> save "Meeting on Thursday"
- She says "I like working out in the morning" -> save "Prefers morning workouts"

Never skip this block when a concrete fact is shared. Save what you know now, even if incomplete.

Snooze a focus item (when Brooke wants to remove something from her focus list temporarily and bring it back at a specific time):
[ACTION]{"type":"snooze_priority","label":"M Racing","restoreAt":"2026-04-03T12:00:00"}[/ACTION]
label: a substring of the item's label (used to find it). restoreAt: ISO datetime when it should automatically return to the focus list. It will reappear the next time she opens the app after that time. Confirm what you snoozed and when it comes back.

ACTION RULE:
When Brooke explicitly asks you to update, plan, or set her priorities - or when you are recommending a concrete set of things to focus on today - append this block at the very end of your response, after any MEMORY block:
[ACTION]{"type":"set_priorities","items":[{"label":"Task name","category":"Category","color":"blue"}]}[/ACTION]

Color options: blue (Academic), orange (Racing/Engineering), green (Movement/Gym), pink (Personal/Faith), purple (Other).
Max 5 items. Only emit this when you have a concrete, actionable list to set. Not for general conversation.

You can also emit these action types when appropriate:

Set or update a day's schedule (AUTOMATICALLY any time Brooke mentions a concrete event with a time and/or date - exam, meeting, class, lab, appointment, deadline, commute, deep work block, anything. Do NOT wait for her to ask. If she says "my thermo exam is Friday at noon", immediately add it. If she says "I have lab tonight at 6:30", add it. This is non-negotiable - every concrete event goes on the calendar):
[ACTION]{"type":"set_schedule","date":"YYYY-MM-DD","items":[{"time":"9:00 AM","title":"Event name","note":"optional note","color":"blue"}]}[/ACTION]
Always include the date field as YYYY-MM-DD for the specific day. Use the exact date you were given at the top of this prompt.
To CLEAR a day entirely, send items as an empty array: "items":[]
To REMOVE one event, re-send the full day's schedule with that event omitted.
To ADD an event, re-send the full schedule with the new event included in the right time order.
This action always replaces the full schedule for that date - so always include all events you want to keep.
When adding a new event to an existing day, fetch the current schedule from your context/memory and include all existing events plus the new one. If you don't know the existing events, add just the new one and note that she may want to confirm the rest.

IMPORTANT: The set_schedule action takes priority over all other action types when a concrete event is mentioned. Use it immediately.

Update ritual streaks (when Brooke logs a completed habit - Bible reading or gym):
[ACTION]{"type":"update_rituals","bible":5,"gym":3,"bible_today":true,"gym_today":false,"date":"YYYY-MM-DD"}[/ACTION]
bible and gym are the current week totals (0-7 and 0-5). bible_today and gym_today are booleans for whether she did each one. Include all four fields.
CRITICAL: Always include the "date" field. Use the date she actually means - not always today. Examples:
- She says "I did my Tuesday workout" on Wednesday at 12am → use Tuesday's date
- She says "log my Bible for this morning" at 1am Wednesday → use Tuesday's date (she hasn't slept yet)
- She says "mark my workout for Saturday" → use Saturday's date
- She says "I just did it" at 3pm → use today's date
Use the exact ISO date (YYYY-MM-DD). Never default blindly to today - infer from what she said and what time it is.

Update semester goal progress (when Brooke reports a grade, finishes an assignment, adds/completes a milestone, or asks to update a goal):
[ACTION]{"type":"set_goal_progress","goals":[{"title":"Thermodynamics","desc":"B+ or better - building toward the engineer who understands the full system.","progress":80,"color":"#5092eb","tasks":[{"label":"Problem set 1","done":true},{"label":"Final exam","done":false}]}]}[/ACTION]
Always include the full tasks array when you know milestones for a goal. Progress is auto-computed from tasks if tasks are present, but include your best estimate anyway.

Update M Racing checklist (when Brooke completes or adds a racing task):
[ACTION]{"type":"update_racing_checklist","items":[{"label":"Sponsorship email campaign (250 sent)","done":true},{"label":"Follow up on sponsor leads","done":false}]}[/ACTION]

Start a deep work session (when Brooke explicitly asks to start a focused/deep work block - she will tell you what she's working on and for how long):
[ACTION]{"type":"start_deep_work","task":"Thermodynamics problem set","duration":90}[/ACTION]
task is the specific thing she's working on. duration is in minutes (integer). Only emit this when you have BOTH the task and duration confirmed. If she says "deep work" without specifying, ask what she's working on and for how long before emitting. Confirm the session warmly and briefly - then emit the action. She's committing to a focused block.

Save recurring weekly class schedule (when Brooke tells you her class schedule that repeats weekly - e.g. "Thermo is MWF 10-11am"):
[ACTION]{"type":"set_recurring_schedule","schedule":{"monday":[{"time":"10:00 AM","title":"ME 335 Thermodynamics","color":"blue"}],"wednesday":[{"time":"10:00 AM","title":"ME 335 Thermodynamics","color":"blue"}],"friday":[{"time":"10:00 AM","title":"ME 335 Thermodynamics","color":"blue"}]}}[/ACTION]
Keys are lowercase day names (monday-sunday). Each item needs time (12-hour AM/PM), title, and color (blue/orange/green/pink/purple).
This saves permanently - it auto-populates every future occurrence of that day for the rest of the semester.
If a class meets MWF, write it under monday, wednesday, AND friday separately. Confirm warmly once saved.

Add item to backlog (when Brooke mentions something she needs to do eventually but doesn't have a date yet - one-off tasks, errands, things to figure out the timing for later):
[ACTION]{"type":"add_to_backlog","items":[{"id":"unique-slug","title":"What needs to happen","note":"any context or constraints","color":"blue"}]}[/ACTION]
id: lowercase-hyphenated unique slug. color: blue=academic, orange=racing, green=movement, pink=faith, purple=chore/other.
Noa will find the right time to place these when planning.

Set up a recurring task (when Brooke tells you something she does on a regular cadence - laundry, groceries, cleaning, etc.):
[ACTION]{"type":"set_recurring_task","task":{"id":"laundry","title":"Laundry","frequencyDays":14,"flexDays":3,"color":"purple","lastDone":"2026-03-22","note":"~1 hour"}}[/ACTION]
id: lowercase-hyphenated slug. frequencyDays: how often it repeats (7=weekly, 14=biweekly). flexDays: how many days early or late is acceptable. lastDone: ISO date of last completion (null if never). note: duration/details.
Noa picks the optimal day each cycle - never back-to-back, never within 3 days of lastDone, avoids packed days.

Mark a recurring task as done (when Brooke says she did her laundry, groceries, cleaning, etc.):
[ACTION]{"type":"complete_recurring_task","id":"laundry","date":"2026-03-30"}[/ACTION]
Updates lastDone so Noa calculates the next optimal occurrence. Use today's date unless she specifies otherwise.

Remove from backlog (when a backlog item gets placed on the calendar or is no longer needed):
[ACTION]{"type":"remove_from_backlog","id":"item-slug"}[/ACTION]

Only one [ACTION] block per response. If multiple actions are needed, pick the most important one. When in doubt between set_schedule and any other action type, always pick set_schedule if a concrete event was mentioned.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const { messages, priorities, weekHabits, energy, todayDW, racingChecklist, semesterGoals } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Use client's local date — never server UTC, which drifts ahead for US timezones after ~8pm
  const todayISO = req.body.clientDate || new Date().toISOString().split('T')[0];
  const todayReadable = new Date(todayISO + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // Load Noa's memory
  let memoryFacts = [];
  try {
    memoryFacts = await kv.get(MEMORY_KEY) || [];
  } catch (e) {
    // KV not configured yet - degrade gracefully
  }

  const memoryBlock = memoryFacts.length > 0
    ? `\n\nWhat you've learned about Brooke from past conversations:\n${memoryFacts.map(f => `- ${f}`).join('\n')}`
    : '';

  const correctYear = todayISO.split('-')[0]; // e.g. "2026"
  const dateBlock = `\n\nCRITICAL: Today is ${todayReadable} (${todayISO}). The year is ${correctYear}. You MUST use ${todayISO} (or a future date in ${correctYear}) in all action blocks that require a date field. Never use a past year.`;

  const MODE_CONTEXT = {
    student: `\n\nACTIVE MODE: Student. Brooke is in heads-down academic mode. Focus on classes, Canvas deadlines, problem sets, exam prep, and deep work blocks. Keep suggestions academic. Don't bring up M Racing unless she asks.`,
    racing: `\n\nACTIVE MODE: M Racing. Brooke is in racing/team mode. Focus on M Racing tasks, team meetings, Wilson Center schedule, business subteam responsibilities, Director role progress. Don't bring up academic assignments unless she asks.`,
    builder: `\n\nACTIVE MODE: Builder. Brooke is thinking long-horizon. Focus on the Ross application, the team website, anything she's constructing toward her future. The Sydney vision is the north star here. Think in months and years, not just today.`,
    personal: `\n\nACTIVE MODE: Personal. This is Brooke's quieter, grounding mode. Focus on her anchors - Bible reading streak, gym sessions, morning routine, the Sydney vision. Keep the tone calm and reflective. No task lists, no deadlines. This is about who she is, not what she has to do.`,
  };
  const mode = req.body.mode || 'student';
  const modeBlock = MODE_CONTEXT[mode] || MODE_CONTEXT.student;

  // Load live Canvas data so Noa actually knows what's on Canvas during chat
  const { block: canvasBlock, courses } = await loadCanvasForChat(todayISO);
  const coursesLine = courses.length > 0
    ? `\n\nCourses detected from Canvas this semester: ${courses.join(', ')}`
    : '';

  // Load everything from Redis in parallel
  let recurringSchedule = {}, todaySchedule = [], backlog = [], recurringTasks = [];
  try {
    [recurringSchedule, todaySchedule, backlog, recurringTasks] = await Promise.all([
      kv.get(RECURRING_KEY).then(v => v || {}).catch(() => ({})),
      kv.get(`noa_schedule_${todayISO}`).then(v => v || []).catch(() => []),
      kv.get(BACKLOG_KEY).then(v => v || []).catch(() => []),
      kv.get(RECURRING_TASKS_KEY).then(v => v || []).catch(() => []),
    ]);
  } catch(e) {}

  const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

  const recurringBlock = Object.keys(recurringSchedule).length > 0
    ? `\n\nSaved recurring class schedule:\n${DAYS.filter(d => recurringSchedule[d]?.length).map(d =>
        `- ${d.charAt(0).toUpperCase()+d.slice(1)}: ${recurringSchedule[d].map(e => `${e.time} ${e.title}`).join(', ')}`
      ).join('\n')}`
    : '\n\nNo recurring class schedule saved yet.';

  // Merge recurring + one-off for today's full schedule
  const todayDayName = DAYS[new Date(todayISO + 'T12:00:00').getDay()];
  const recurringToday = recurringSchedule[todayDayName] || [];
  const fullTodaySchedule = [...recurringToday, ...todaySchedule];
  const scheduleBlock = fullTodaySchedule.length > 0
    ? `\n\nToday's full schedule:\n${fullTodaySchedule.map(i => `- ${i.time}: ${i.title}${i.note ? ` (${i.note})` : ''}`).join('\n')}`
    : '\n\nNo schedule set for today yet.';

  const prioritiesBlock = priorities && priorities.length > 0
    ? `\n\nCurrent focus list (Today's Focus on dashboard):\n${priorities.map(p => `- ${p.label} (${p.category})`).join('\n')}\nTo remove an item, re-emit set_priorities without it. To add, include it in the list.`
    : '\n\nNo items on the focus list right now.';

  // Habits this week
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const habitLines = weekHabits && Object.keys(weekHabits).length > 0
    ? Object.entries(weekHabits).map(([date, h]) => {
        const d = new Date(date + 'T12:00:00');
        return `- ${DAY_NAMES[d.getDay()]} ${date}: Bible=${h.bible ? 'done' : 'no'}, Gym=${h.gym ? 'done' : 'no'}`;
      }).join('\n')
    : 'No habits logged this week yet.';
  const habitsBlock = `\n\nThis week's habit log:\n${habitLines}`;

  const energyBlock = energy ? `\n\nToday's energy level: ${energy}` : '';

  const dwBlock = todayDW && todayDW.length > 0
    ? `\n\nDeep work sessions today: ${todayDW.map(s => `"${s.task}" (${s.duration}min${s.completed ? ', completed' : ', in progress'})`).join(', ')}`
    : '';

  const racingBlock = racingChecklist && racingChecklist.length > 0
    ? `\n\nM Racing checklist:\n${racingChecklist.map(i => `- [${i.done ? 'x' : ' '}] ${i.label}`).join('\n')}`
    : '';

  const goalsBlock = semesterGoals && semesterGoals.length > 0
    ? `\n\nSemester goals:\n${semesterGoals.map(g => `- ${g.title}: ${g.desc} (progress: ${g.progress}%)`).join('\n')}`
    : '';

  const backlogBlock = backlog.length > 0
    ? `\n\nBacklog (things to do eventually, no date yet):\n${backlog.map(i => `- ${i.title}${i.note ? `: ${i.note}` : ''}`).join('\n')}`
    : '';

  const recurringTasksBlock = recurringTasks.length > 0
    ? `\n\nRecurring tasks:\n${recurringTasks.map(t => `- ${t.title}: every ${t.frequencyDays} days, last done ${t.lastDone || 'never'}`).join('\n')}`
    : '';

  const systemPrompt = BASE_SYSTEM + dateBlock + coursesLine + modeBlock + canvasBlock
    + scheduleBlock + recurringBlock + prioritiesBlock + habitsBlock
    + energyBlock + dwBlock + racingBlock + goalsBlock + backlogBlock + recurringTasksBlock
    + memoryBlock;

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
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const rawReply = data.content[0].text;

    // Extract memory block if present
    const memoryMatch = rawReply.match(/\[MEMORY\]([\s\S]*?)\[\/MEMORY\]/);
    const cleanReply = rawReply.replace(/\[MEMORY\][\s\S]*?\[\/MEMORY\]/g, '').trim();

    if (memoryMatch) {
      try {
        const { facts } = JSON.parse(memoryMatch[1]);
        if (Array.isArray(facts) && facts.length > 0) {
          const existing = await kv.get(MEMORY_KEY) || [];
          const updated = [...new Set([...existing, ...facts])].slice(-100);
          await kv.set(MEMORY_KEY, updated);
        }
      } catch (e) {
        // Memory parse failed - not critical
      }
    }

    // Extract action block if present
    const actionMatch = cleanReply.match(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/);
    const finalReply = cleanReply.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/g, '').trim();

    let actions = null;
    if (actionMatch) {
      try {
        const parsed = JSON.parse(actionMatch[1]);
        if (parsed.type) {
          actions = parsed;
          // Persist one-off schedule to Redis
          if (parsed.type === 'set_schedule' && Array.isArray(parsed.items)) {
            let scheduleDate = parsed.date || todayISO;
            // Correct year if model hallucinated the wrong year (e.g. 2025 instead of 2026)
            scheduleDate = scheduleDate.replace(/^\d{4}/, correctYear);
            await kv.set(`noa_schedule_${scheduleDate}`, parsed.items);
          }
          // Persist recurring class schedule to Redis
          if (parsed.type === 'set_recurring_schedule' && parsed.schedule) {
            const existing = await kv.get(RECURRING_KEY) || {};
            const merged = { ...existing };
            for (const [day, items] of Object.entries(parsed.schedule)) {
              if (Array.isArray(items)) merged[day.toLowerCase()] = items;
            }
            await kv.set(RECURRING_KEY, merged);
          }
          // Add items to backlog
          if (parsed.type === 'add_to_backlog' && Array.isArray(parsed.items)) {
            const existing = await kv.get(BACKLOG_KEY) || [];
            const newItems = parsed.items.map(item => ({
              ...item,
              id: item.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
              addedAt: todayISO,
            }));
            await kv.set(BACKLOG_KEY, [...existing, ...newItems]);
          }
          // Remove from backlog
          if (parsed.type === 'remove_from_backlog' && parsed.id) {
            const existing = await kv.get(BACKLOG_KEY) || [];
            await kv.set(BACKLOG_KEY, existing.filter(i => i.id !== parsed.id));
          }
          // Set up or update a recurring task
          if (parsed.type === 'set_recurring_task' && parsed.task) {
            const existing = await kv.get(RECURRING_TASKS_KEY) || [];
            const idx = existing.findIndex(t => t.id === parsed.task.id);
            if (idx >= 0) existing[idx] = parsed.task;
            else existing.push(parsed.task);
            await kv.set(RECURRING_TASKS_KEY, existing);
          }
          // Mark recurring task complete
          if (parsed.type === 'complete_recurring_task' && parsed.id) {
            const existing = await kv.get(RECURRING_TASKS_KEY) || [];
            const idx = existing.findIndex(t => t.id === parsed.id);
            if (idx >= 0) {
              existing[idx].lastDone = parsed.date || todayISO;
              await kv.set(RECURRING_TASKS_KEY, existing);
            }
          }
        }
      } catch (e) {
        // Action parse failed - not critical
      }
    }

    res.json({ reply: finalReply, ...(actions && { actions }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
