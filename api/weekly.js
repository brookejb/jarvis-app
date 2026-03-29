import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();
const MEMORY_KEY = 'noa_memory';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  let memoryFacts = [];
  try {
    memoryFacts = await kv.get(MEMORY_KEY) || [];
  } catch (e) {}

  const memoryBlock = memoryFacts.length > 0
    ? `\nWhat you know about Brooke:\n${memoryFacts.map(f => `- ${f}`).join('\n')}`
    : '';

  const systemPrompt = `You are Noa, Brooke's personal AI planning partner. Today is ${today}.${memoryBlock}

Return a JSON object with this exact structure - no other text, just valid JSON:
{
  "insight": "One punchy sentence about this week. Be specific. No em dashes. Use a comma or hyphen instead.",
  "insightDetail": "One sentence of supporting context. Be concrete.",
  "deadlines": [
    { "title": "Task name", "due": "Due Mon", "category": "Academic", "color": "blue" }
  ]
}

Color options: blue (Academic), orange (Racing), green (Movement), pink (Personal/Faith), purple (Other).
Include only deadlines you actually know about from memory. Max 5. If you know nothing specific, return an empty deadlines array.`;

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
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Weekly overview.' }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = data.content[0].text.trim();
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
