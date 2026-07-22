const { createClient } = require('redis');

const memory = new Map();
let client;
let connectionAttempt;

function getMemory(key) {
  const item = memory.get(key);
  if (!item || item.expiresAt <= Date.now()) { memory.delete(key); return null; }
  return item.value;
}

async function redisClient() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 1500, reconnectStrategy: false } });
    client.on('error', error => console.warn('Redis unavailable; using in-memory cache:', error.message));
  }
  if (!client.isOpen) {
    connectionAttempt ||= client.connect().catch(error => { console.warn('Redis connection failed; using in-memory cache:', error.message); return null; }).finally(() => { connectionAttempt = null; });
    await connectionAttempt;
  }
  return client.isOpen ? client : null;
}

async function get(key) {
  const redis = await redisClient();
  if (redis) {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  }
  return getMemory(key);
}

async function set(key, value, ttlSeconds) {
  const redis = await redisClient();
  if (redis) await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  return value;
}

async function delByPrefix(prefix) {
  for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key);
  const redis = await redisClient();
  if (!redis) return;
  for await (const keys of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) if (keys.length) await redis.del(keys);
}

module.exports = { get, set, delByPrefix };
