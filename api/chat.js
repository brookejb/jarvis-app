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

Set today's schedule (when Brooke tells you what her day looks like):
[ACTION]{"type":"set_schedule","items":[{"time":"9:00 AM","title":"Event name","note":"optional note","color":"blue"}]}[/ACTION]

Update ritual streaks (when Brooke logs a completed habit - Bible reading or gym):
[ACTION]{"type":"update_rituals","bible":5,"gym":3,"bible_today":true,"gym_today":false}[/ACTION]
bible and gym are the current week totals (0-7 and 0-5). bible_today and gym_today are booleans for whether she did each one today. Include all four fields.

Update semester goal progress (when Brooke reports a grade, finishes an assignment, or asks to update a goal):
[ACTION]{"type":"set_goal_progress","goals":[{"title":"Thermodynamics","desc":"B+ or better - building toward the engineer who understands the full system.","progress":80,"color":"#5092eb"}]}[/ACTION]

Update M Racing checklist (when Brooke completes or adds a racing task):
[ACTION]{"type":"update_racing_checklist","items":[{"label":"Sponsorship email campaign (250 sent)","done":true},{"label":"Follow up on sponsor leads","done":false}]}[/ACTION]

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

  const systemPrompt = BASE_SYSTEM + memoryBlock;

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
            await kv.set(`noa_schedule_${today}`, parsed.items);
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
