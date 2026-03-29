import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const hasUrl = !!process.env.UPSTASH_REDIS_REST_URL;
  const hasToken = !!process.env.UPSTASH_REDIS_REST_TOKEN;
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

  let redisStatus = 'not tested';
  let memoryFacts = [];
  let redisError = null;

  if (hasUrl && hasToken) {
    try {
      const kv = Redis.fromEnv();
      memoryFacts = await kv.get('noa_memory') || [];
      redisStatus = 'connected';
    } catch (e) {
      redisStatus = 'error';
      redisError = e.message;
    }
  } else {
    redisStatus = 'missing env vars';
  }

  res.json({
    env: {
      UPSTASH_REDIS_REST_URL: hasUrl ? 'set' : 'MISSING',
      UPSTASH_REDIS_REST_TOKEN: hasToken ? 'set' : 'MISSING',
      ANTHROPIC_API_KEY: hasAnthropicKey ? 'set' : 'MISSING',
    },
    redis: redisStatus,
    redisError,
    memoryCount: memoryFacts.length,
    memory: memoryFacts,
  });
}
