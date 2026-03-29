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

Give a single sharp, honest insight about where Brooke stands on her goals right now. 1-2 sentences. Be specific - reference a real goal, deadline, or habit. Connect today's actions to the bigger picture. No em dashes. No fluff.`;

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
        messages: [{ role: 'user', content: 'Goals insight.' }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    res.json({ insight: data.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
