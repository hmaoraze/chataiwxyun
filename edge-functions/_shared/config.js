import {
  CONFIG_KEY,
  DEFAULT_CONFIG,
  MASTER_KEY,
  SECRET_PATHS,
  VERSION,
} from './constants.js';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecret,
} from './crypto.js';
import { openConfigStore, sanitizePrefix } from './store.js';
import { clone, randomHex, safeJsonParse } from './util.js';

export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

export function getPath(object, path) {
  return path.reduce((current, key) => (current == null ? current : current[key]), object);
}

export function setPath(object, path, value) {
  let current = object;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  current[path[path.length - 1]] = value;
}

export async function getMasterKey(env = {}, storeOverride = null) {
  if (env.APP_MASTER_KEY && String(env.APP_MASTER_KEY).length >= 16) {
    return { secret: String(env.APP_MASTER_KEY), source: 'env', store: storeOverride };
  }
  const opened = storeOverride
    ? { store: storeOverride, mode: storeOverride.mode, available: storeOverride.mode !== 'memory' }
    : openConfigStore(env);
  let secret = await opened.store.get(MASTER_KEY);
  if (!secret) {
    secret = randomHex(32);
    await opened.store.put(MASTER_KEY, secret);
  }
  return {
    secret,
    source: opened.available ? 'auto' : 'ephemeral',
    store: opened.store,
  };
}

export async function readRawConfig(env = {}) {
  const opened = openConfigStore(env);
  const raw = safeJsonParse(await opened.store.get(CONFIG_KEY), null) || {};
  return { raw, ...opened };
}

export async function loadConfig(env = {}) {
  const { raw, store, mode, bindingName, available } = await readRawConfig(env);
  const config = deepMerge(clone(DEFAULT_CONFIG), raw);
  const master = await getMasterKey(env, store);
  for (const path of SECRET_PATHS) {
    const encrypted = getPath(raw, path);
    const plain = encrypted ? await decryptSecret(encrypted, master.secret) : '';
    setPath(config, path, plain);
  }
  Object.defineProperty(config, '__meta', {
    value: {
      version: VERSION,
      masterKeySource: master.source,
      configStoreMode: mode,
      configStoreBinding: bindingName,
      configStoreAvailable: available,
    },
    enumerable: false,
    configurable: true,
  });
  return config;
}

export async function saveConfig(env = {}, patch = {}) {
  const { raw, store } = await readRawConfig(env);
  const master = await getMasterKey(env, store);
  const base = deepMerge(clone(DEFAULT_CONFIG), raw);
  const clear = new Set(Array.isArray(patch.clearSecrets) ? patch.clearSecrets : []);
  const safePatch = clone(patch);
  delete safePatch.clearSecrets;

  // 密钥字段单独处理：空字符串表示保持原值
  const secretValues = new Map();
  for (const path of SECRET_PATHS) {
    const incoming = getPath(safePatch, path);
    const dot = path.join('.');
    if (incoming !== undefined) {
      deletePath(safePatch, path);
      if (incoming === null || clear.has(dot)) {
        secretValues.set(dot, '');
      } else if (String(incoming).trim()) {
        secretValues.set(dot, await encryptSecret(String(incoming).trim(), master.secret));
      }
    } else if (clear.has(dot)) {
      secretValues.set(dot, '');
    }
  }

  const next = deepMerge(base, safePatch);
  next.version = 1;
  next.updatedAt = new Date().toISOString();
  if (!next.initializedAt) next.initializedAt = next.updatedAt;
  next.storage.keyPrefix = sanitizePrefix(next.storage.keyPrefix, 'cb');

  for (const [dot, value] of secretValues.entries()) {
    setPath(next, dot.split('.'), value);
  }
  // 保证所有密钥字段保持密文或空
  for (const path of SECRET_PATHS) {
    const value = getPath(next, path);
    if (value && !isEncryptedSecret(value)) {
      setPath(next, path, await encryptSecret(String(value), master.secret));
    }
  }

  await store.put(CONFIG_KEY, JSON.stringify(next));
  return loadConfig(env);
}

function deletePath(object, path) {
  let current = object;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!current || typeof current !== 'object') return;
    current = current[path[i]];
  }
  if (current && typeof current === 'object') delete current[path[path.length - 1]];
}

export function clientConfig(config) {
  const out = clone(config);
  delete out.__meta;
  const secrets = {};
  for (const path of SECRET_PATHS) {
    const value = getPath(config, path) || '';
    setPath(out, path, '');
    secrets[path.join('.')] = {
      has: Boolean(value),
      hint: value ? maskSecret(value) : '',
    };
  }
  out.secretStatus = secrets;
  return out;
}

export function requiredStatus(config, meta = {}) {
  const storage = config.storage || {};
  const driver = storage.driver || 'kv';
  let storageOk = false;
  if (driver === 'redis') storageOk = Boolean(storage.redisUrl && storage.redisToken);
  else if (driver === 'kv') storageOk = Boolean(storage.kvBinding) && meta.configStoreAvailable !== false;
  else storageOk = false;

  const items = {
    deepseekApiKey: Boolean(config.deepseek.apiKey),
    systemPrompt: Boolean(String(config.prompt.systemPrompt || '').trim()),
    storage: storageOk,
    serviceToken: Boolean(config.api.serviceToken),
    wechatBotToken: Boolean(config.wechat.botToken),
    wechatBaseUrl: Boolean(config.wechat.baseUrl),
    wechatIlinkIds: Boolean(config.wechat.ilinkBotId && config.wechat.ilinkUserId),
  };
  const labels = {
    deepseekApiKey: 'DeepSeek API Key',
    systemPrompt: '前置提示词（人设、规则与输出约束）',
    storage: '会话与记忆存储',
    serviceToken: '服务访问令牌',
    wechatBotToken: '微信机器人 bot_token',
    wechatBaseUrl: '微信 iLink 基座地址',
    wechatIlinkIds: 'ilink_bot_id 与 ilink_user_id',
  };
  return {
    items,
    labels,
    missing: Object.entries(items)
      .filter(([, value]) => !value)
      .map(([key]) => key),
    complete: Object.values(items).every(Boolean),
  };
}
