import { HttpError } from './http.js';
import { openConfigStore } from './store.js';
import { sha256Hex } from './util.js';

export async function rateLimit(env, { bucket, key, limit = 30, windowSeconds = 60 }) {
  const { store } = openConfigStore(env);
  const digest = (await sha256Hex(String(key || 'unknown'))).slice(0, 16);
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const storeKey = `cb_rl_${bucket}_${digest}_${window}`;
  const current = Number(await store.get(storeKey)) || 0;
  const next = current + 1;
  await store.put(storeKey, String(next));
  if (next > limit) {
    throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
  }
  return { count: next, remaining: Math.max(0, limit - next) };
}
