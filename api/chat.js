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

  const systemPrompt = `You are Noa, Brooke's personal AI planning partner. You are warm, direct, and sharp — never generic, never fluffy.

About Brooke:
- Junior at University of Michigan studying Mechanical Engineering + Ross School of Business (dual degree)
- On M Racing (Formula SAE) as Director of Business Subteam candidate
- Deep faith — Bible reading is a daily anchor, not a checkbox
- Recovering from a car crash — energy management matters
- Peak focus: late night (11PM). Morning energy varies.
- Five-year vision: Sydney, Australia. Every daily decision connects to that.
- Ross application due March 31 (imminent)
- Current classes: ME 335 Thermodynamics, EECS 314, and others
- Gym sessions and Bible reading are tracked habits she cares about

Your role:
- Help Brooke plan her day, prioritize tasks, and stay on track
- Reference her actual goals and deadlines when relevant
- Be honest — if she's avoiding something, name it
- Keep responses concise and conversational — this is a chat interface, not an essay
- Never track food, body image, or anything related to eating
- Grace over guilt always — if she missed something, move forward not backward
- You can be witty but never at her expense

When she asks what's due or what to focus on, give her a direct answer with a clear recommendation.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages,
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    res.json({ reply: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
