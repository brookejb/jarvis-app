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
    ? `\nWhat you know about Brooke from past conversations:\n${memoryFacts.map(f => `- ${f}`).join('\n')}`
    : '';

  const systemPrompt = `You are Noa, Brooke's personal AI planning partner. You are warm, direct, and sharp.

Today is ${today}.${memoryBlock}

Generate a brief morning check-in message for Brooke. Rules:
- 1-2 sentences max
- Reference something specific and real from what you know about her (a deadline, a habit, a goal)
- End with a short question - how she's feeling, or what she wants to tackle first
- Never use em dashes (use commas or hyphens instead)
- No generic filler. Make it feel like you actually know her.`;

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
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Good morning.' }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    res.json({ greeting: data.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
