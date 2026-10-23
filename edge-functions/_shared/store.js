import { randomHex } from './util.js';

export class StoreError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StoreError';
    this.cause = cause;
  }
}

class BaseStore {
  constructor(mode) {
    this.mode = mode;
  }

  async getJson(key) {
    const value = await this.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  async putJson(key, value) {
    await this.put(key, JSON.stringify(value));
  }

  async probe() {
    const key = `cb_probe_${randomHex(6)}`;
    const token = randomHex(8);
    const started = Date.now();
    await this.put(key, token);
    const value = await this.get(key);
    await this.delete(key);
    if (value !== token) throw new StoreError('存储读写校验失败');
    return { mode: this.mode, latencyMs: Date.now() - started };
  }
}

export class MemoryStore extends BaseStore {
  constructor() {
    super('memory');
    this.map = new Map();
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async put(key, value) {
    this.map.set(key, String(value));
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list({ prefix = '', limit = 256, cursor = null } = {}) {
    const keys = [...this.map.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    let start = 0;
    if (cursor) {
      const index = keys.indexOf(cursor);
      start = index >= 0 ? index : keys.length;
    }
    const page = keys.slice(start, start + Math.max(1, Math.min(limit, 256)));
    const complete = start + page.length >= keys.length;
    return {
      keys: page.map((key) => ({ key })),
      cursor: complete ? null : page[page.length - 1],
      complete,
    };
  }
}

export class KVStore extends BaseStore {
  constructor(binding, name = 'chat_kv') {
    super('kv');
    this.binding = binding;
    this.name = name;
  }

  async get(key) {
    return this.binding.get(key);
  }

  async put(key, value) {
    await this.binding.put(key, String(value));
  }

  async delete(key) {
    await this.binding.delete(key);
  }

  async list({ prefix = '', limit = 256, cursor = null } = {}) {
    const result = await this.binding.list({
      prefix,
      limit: Math.max(1, Math.min(limit, 256)),
      cursor: cursor || undefined,
    });
    return {
      keys: (result.keys || []).map((item) =>
        typeof item === 'string' ? { key: item } : item
      ),
      cursor: result.cursor || null,
      complete: Boolean(result.complete) || !result.cursor,
    };
  }
}

export class RedisStore extends BaseStore {
  constructor({ url, token, timeoutMs = 10000 }) {
    super('redis');
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = String(token || '');
    this.timeoutMs = timeoutMs;
  }

  async command(args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new StoreError(`Redis 返回非 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok || payload.error) {
        throw new StoreError(
          `Redis 命令失败：${payload.error || `HTTP ${response.status}`}`
        );
      }
      return payload.result;
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(`Redis 连接失败：${error.message}`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key) {
    return this.command(['GET', key]);
  }

  async put(key, value) {
    await this.command(['SET', key, String(value)]);
  }

  async delete(key) {
    await this.command(['DEL', key]);
  }

  async list({ prefix = '', limit = 100, cursor = '0' } = {}) {
    let current = cursor && cursor !== 'null' ? String(cursor) : '0';
    const result = await this.command([
      'SCAN',
      current,
      'MATCH',
      `${prefix}*`,
      'COUNT',
      String(Math.max(1, Math.min(limit, 500))),
    ]);
    const [next, keys] = result || ['0', []];
    return {
      keys: (keys || []).map((key) => ({ key })),
      cursor: String(next) === '0' ? null : String(next),
      complete: String(next) === '0',
    };
  }
}

// 本地开发或无 KV 绑定时复用一个进程内存储，避免每次请求都丢失状态
let fallbackStore = null;

export function getFallbackStore() {
  if (!fallbackStore) fallbackStore = new MemoryStore();
  return fallbackStore;
}

export function sanitizePrefix(value, fallback = 'cb') {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 24);
  return cleaned || fallback;
}

export function resolveKv(env, name) {
  const bindingName = String(name || 'chat_kv');
  const candidates = [];
  if (env && env[bindingName]) candidates.push(env[bindingName]);
  if (typeof globalThis !== 'undefined' && globalThis[bindingName]) {
    candidates.push(globalThis[bindingName]);
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate.get === 'function' && typeof candidate.put === 'function') {
      return candidate;
    }
  }
  return null;
}

export function openConfigStore(env = {}) {
  const bindingName = env.CONFIG_KV_BINDING || 'chat_kv';
  const binding = resolveKv(env, bindingName);
  if (!binding) {
    return { store: getFallbackStore(), mode: 'memory', bindingName, available: false };
  }
  return { store: new KVStore(binding, bindingName), mode: 'kv', bindingName, available: true };
}

export function openBusinessStore(config, env = {}) {
  const storage = config?.storage || {};
  const driver = storage.driver || 'kv';
  if (driver === 'redis') {
    if (!storage.redisUrl) {
      throw new StoreError('尚未配置 Redis 存储地址');
    }
    return {
      store: new RedisStore({
        url: storage.redisUrl,
        token: storage.redisToken,
        timeoutMs: Math.min(15000, Number(config?.deepseek?.timeoutMs) || 10000),
      }),
      mode: 'redis',
      available: true,
    };
  }
  if (driver === 'memory') {
    return { store: getFallbackStore(), mode: 'memory', available: true };
  }
  const bindingName = storage.kvBinding || 'chat_kv';
  const binding = resolveKv(env, bindingName);
  if (!binding) {
    return {
      store: getFallbackStore(),
      mode: 'memory',
      bindingName,
      available: false,
      error: `未找到名为 ${bindingName} 的 KV 命名空间绑定，已临时降级为进程内存储`,
    };
  }
  return { store: new KVStore(binding, bindingName), mode: 'kv', available: true };
}

export async function listAll(store, prefix, maxItems = 1000) {
  const items = [];
  let cursor = null;
  do {
    const page = await store.list({ prefix, limit: 256, cursor });
    for (const item of page.keys || []) items.push(item.key);
    cursor = page.complete ? null : page.cursor;
  } while (cursor && items.length < maxItems);
  return items.slice(0, maxItems);
}
