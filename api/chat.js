import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const MEMORY_KEY = 'noa_memory';

const BASE_SYSTEM = `You are Noa, Brooke's personal AI planning partner. You are warm, direct, and sharp - never generic, never fluffy.

About Brooke:
- Junior at University of Michigan studying Mechanical Engineering + Ross School of Business (dual degree)
- On M Racing (Formula SAE) as Director of Business Subteam candidate
- Deep faith - Bible reading is a daily anchor, not a checkbox
- Recovering from a car crash - energy management matters
- Peak focus: late night (11PM). Morning energy varies.
- Five-year vision: Sydney, Australia. Every daily decision connects to that.
- Ross application due March 31 (imminent)
- Current classes: ME 335 Thermodynamics, EECS 314, and others
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

ACTION RULE:
When Brooke explicitly asks you to update, plan, or set her priorities - or when you are recommending a concrete set of things to focus on today - append this block at the very end of your response, after any MEMORY block:
[ACTION]{"type":"set_priorities","items":[{"label":"Task name","category":"Category","color":"blue"}]}[/ACTION]

Color options: blue (Academic), orange (Racing/Engineering), green (Movement/Gym), pink (Personal/Faith), purple (Other).
Max 5 items. Only emit this when you have a concrete, actionable list to set. Not for general conversation.

You can also emit these action types when appropriate:

Set or update a day's schedule (when Brooke tells you what her day looks like, adds events, removes events, or clears a day):
[ACTION]{"type":"set_schedule","date":"YYYY-MM-DD","items":[{"time":"9:00 AM","title":"Event name","note":"optional note","color":"blue"}]}[/ACTION]
Always include the date field as YYYY-MM-DD for the specific day. Use the exact date you were given at the top of this prompt.
To CLEAR a day entirely, send items as an empty array: "items":[]
To REMOVE one event, re-send the full day's schedule with that event omitted.
To ADD an event, re-send the full schedule with the new event included in the right time order.
This action always replaces the full schedule for that date - so always include all events you want to keep.

Update ritual streaks (when Brooke logs a completed habit - Bible reading or gym):
[ACTION]{"type":"update_rituals","bible":5,"gym":3,"bible_today":true,"gym_today":false}[/ACTION]
bible and gym are the current week totals (0-7 and 0-5). bible_today and gym_today are booleans for whether she did each one today. Include all four fields.

Update semester goal progress (when Brooke reports a grade, finishes an assignment, or asks to update a goal):
[ACTION]{"type":"set_goal_progress","goals":[{"title":"Thermodynamics","desc":"B+ or better - building toward the engineer who understands the full system.","progress":80,"color":"#5092eb"}]}[/ACTION]

Update M Racing checklist (when Brooke completes or adds a racing task):
[ACTION]{"type":"update_racing_checklist","items":[{"label":"Sponsorship email campaign (250 sent)","done":true},{"label":"Follow up on sponsor leads","done":false}]}[/ACTION]

Start a deep work session (when Brooke explicitly asks to start a focused/deep work block - she will tell you what she's working on and for how long):
[ACTION]{"type":"start_deep_work","task":"Thermodynamics problem set","duration":90}[/ACTION]
task is the specific thing she's working on. duration is in minutes (integer). Only emit this when you have BOTH the task and duration confirmed. If she says "deep work" without specifying, ask what she's working on and for how long before emitting. Confirm the session warmly and briefly - then emit the action. She's committing to a focused block.

Only one [ACTION] block per response. If multiple actions are needed, pick the most important one.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const { messages } = req.body;
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

  const dateBlock = `\n\nToday is ${todayReadable} (${todayISO}). Use this exact date when generating any action blocks that require a date field.`;

  const MODE_CONTEXT = {
    student: `\n\nACTIVE MODE: Student. Brooke is in heads-down academic mode. Focus on classes, Canvas deadlines, problem sets, exam prep, and deep work blocks. Keep suggestions academic. Don't bring up M Racing unless she asks.`,
    racing: `\n\nACTIVE MODE: M Racing. Brooke is in racing/team mode. Focus on M Racing tasks, team meetings, Wilson Center schedule, business subteam responsibilities, Director role progress. Don't bring up academic assignments unless she asks.`,
    builder: `\n\nACTIVE MODE: Builder. Brooke is thinking long-horizon. Focus on the Ross application, the team website, anything she's constructing toward her future. The Sydney vision is the north star here. Think in months and years, not just today.`,
    personal: `\n\nACTIVE MODE: Personal. This is Brooke's quieter, grounding mode. Focus on her anchors - Bible reading streak, gym sessions, morning routine, the Sydney vision. Keep the tone calm and reflective. No task lists, no deadlines. This is about who she is, not what she has to do.`,
  };
  const mode = req.body.mode || 'student';
  const modeBlock = MODE_CONTEXT[mode] || MODE_CONTEXT.student;

  const systemPrompt = BASE_SYSTEM + dateBlock + modeBlock + memoryBlock;

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
          // Persist schedule to Redis so it survives page refreshes
          if (parsed.type === 'set_schedule' && Array.isArray(parsed.items)) {
            const today = new Date().toISOString().split('T')[0];
            const scheduleDate = parsed.date || today;
            await kv.set(`noa_schedule_${scheduleDate}`, parsed.items);
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
