import { assertCsrf, requireAdmin } from '../../_shared/auth.js';
import {
  clientConfig,
  deepMerge,
  loadConfig,
  requiredStatus,
  saveConfig,
} from '../../_shared/config.js';
import {
  HttpError,
  handleError,
  ok,
  preflight,
  readJson,
} from '../../_shared/http.js';
import { openBusinessStore, sanitizePrefix } from '../../_shared/store.js';
import { clamp, clone, randomHex, truncateText } from '../../_shared/util.js';

function text(value, field, max = 500) {
  return truncateText(String(value ?? '').trim(), max) || (field ? '' : '');
}

function number(value, field, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function url(value, field, required = false) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw new HttpError(400, 'INVALID_CONFIG', `${field} 不能为空`);
    return '';
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, 'INVALID_CONFIG', `${field} 不是合法 URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, 'INVALID_CONFIG', `${field} 必须使用 http/https`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// 只处理请求中显式出现的字段，未出现的字段保持原配置，便于前端按分区增量保存
function buildPatch(input) {
  const patch = {};
  if (input.deepseek && typeof input.deepseek === 'object') {
    const d = input.deepseek;
    const section = {};
    if (has(d, 'apiKey') && typeof d.apiKey === 'string') section.apiKey = d.apiKey;
    if (has(d, 'baseUrl')) {
      section.baseUrl = url(d.baseUrl, 'DeepSeek Base URL') || 'https://api.deepseek.com';
    }
    if (has(d, 'model')) section.model = text(d.model, 'model', 80) || 'deepseek-chat';
    if (has(d, 'temperature')) {
      section.temperature = number(d.temperature, 'temperature', 0, 2, 0.7);
    }
    if (has(d, 'maxTokens')) {
      section.maxTokens = Math.round(number(d.maxTokens, 'maxTokens', 64, 8192, 1024));
    }
    if (has(d, 'timeoutMs')) {
      section.timeoutMs = Math.round(
        number(d.timeoutMs, 'timeoutMs', 5000, 180000, 60000)
      );
    }
    if (has(d, 'stream')) section.stream = Boolean(d.stream);
    if (has(d, 'maxToolRounds')) {
      section.maxToolRounds = Math.round(
        number(d.maxToolRounds, 'maxToolRounds', 1, 5, 3)
      );
    }
    if (Object.keys(section).length) patch.deepseek = section;
  }
  if (input.prompt && typeof input.prompt === 'object') {
    const p = input.prompt;
    const section = {};
    if (has(p, 'systemPrompt')) {
      const systemPrompt = String(p.systemPrompt || '');
      if (systemPrompt.length > 20000) {
        throw new HttpError(400, 'PROMPT_TOO_LONG', '前置提示词不能超过 20000 字');
      }
      section.systemPrompt = systemPrompt;
    }
    if (has(p, 'maxHistoryMessages')) {
      section.maxHistoryMessages = Math.round(
        number(p.maxHistoryMessages, 'maxHistoryMessages', 2, 100, 20)
      );
    }
    if (has(p, 'maxContextChars')) {
      section.maxContextChars = Math.round(
        number(p.maxContextChars, 'maxContextChars', 4000, 200000, 24000)
      );
    }
    if (Object.keys(section).length) patch.prompt = section;
  }
  if (input.memory && typeof input.memory === 'object') {
    const m = input.memory;
    const section = {};
    if (has(m, 'maxItems')) {
      section.maxItems = Math.round(number(m.maxItems, 'maxItems', 10, 1000, 120));
    }
    if (has(m, 'ttlDays')) {
      section.ttlDays = Math.round(number(m.ttlDays, 'ttlDays', 1, 3650, 180));
    }
    if (has(m, 'summaryMaxChars')) {
      section.summaryMaxChars = Math.round(
        number(m.summaryMaxChars, 'summaryMaxChars', 200, 4000, 1200)
      );
    }
    if (has(m, 'summaryMode')) {
      section.summaryMode = ['auto', 'model', 'off'].includes(m.summaryMode)
        ? m.summaryMode
        : 'auto';
    }
    if (has(m, 'summaryTopK')) {
      section.summaryTopK = Math.round(
        number(m.summaryTopK, 'summaryTopK', 5, 100, 30)
      );
    }
    if (has(m, 'minImportance')) {
      section.minImportance = Math.round(
        number(m.minImportance, 'minImportance', 1, 5, 2)
      );
    }
    if (has(m, 'autoExtractOnEnd')) section.autoExtractOnEnd = Boolean(m.autoExtractOnEnd);
    if (has(m, 'extractMaxItems')) {
      section.extractMaxItems = Math.round(
        number(m.extractMaxItems, 'extractMaxItems', 1, 30, 10)
      );
    }
    if (has(m, 'similarityThreshold')) {
      section.similarityThreshold = Number(
        number(
          m.similarityThreshold,
          'similarityThreshold',
          0.4,
          0.99,
          0.72
        ).toFixed(2)
      );
    }
    if (Object.keys(section).length) patch.memory = section;
  }
  if (input.session && typeof input.session === 'object') {
    const s = input.session;
    const section = {};
    if (has(s, 'ttlMinutes')) {
      section.ttlMinutes = Math.round(number(s.ttlMinutes, 'ttlMinutes', 1, 10080, 120));
    }
    if (has(s, 'idleTimeoutMinutes')) {
      section.idleTimeoutMinutes = Math.round(
        number(s.idleTimeoutMinutes, 'idleTimeoutMinutes', 1, 10080, 45)
      );
    }
    if (has(s, 'maxTurns')) {
      section.maxTurns = Math.round(number(s.maxTurns, 'maxTurns', 1, 500, 60));
    }
    if (has(s, 'maxInputChars')) {
      section.maxInputChars = Math.round(
        number(s.maxInputChars, 'maxInputChars', 100, 20000, 8000)
      );
    }
    if (has(s, 'retentionDays')) {
      section.retentionDays = Math.round(
        number(s.retentionDays, 'retentionDays', 1, 365, 7)
      );
    }
    if (Object.keys(section).length) patch.session = section;
  }
  if (input.storage && typeof input.storage === 'object') {
    const s = input.storage;
    const section = {};
    if (has(s, 'driver')) {
      section.driver = ['kv', 'redis', 'memory'].includes(s.driver) ? s.driver : 'kv';
    }
    if (has(s, 'kvBinding')) {
      const binding = String(s.kvBinding || 'chat_kv').trim();
      if (!/^[A-Za-z0-9_]{1,64}$/.test(binding)) {
        throw new HttpError(400, 'INVALID_CONFIG', 'KV 绑定变量名只能包含字母、数字、下划线');
      }
      section.kvBinding = binding;
    }
    if (has(s, 'redisUrl')) section.redisUrl = s.redisUrl ? url(s.redisUrl, 'Redis 地址') : '';
    if (has(s, 'redisToken') && typeof s.redisToken === 'string') {
      section.redisToken = s.redisToken;
    }
    if (has(s, 'keyPrefix')) section.keyPrefix = sanitizePrefix(s.keyPrefix, 'cb');
    if (Object.keys(section).length) patch.storage = section;
  }
  if (input.api && typeof input.api === 'object') {
    const a = input.api;
    const section = {};
    if (has(a, 'serviceToken') && typeof a.serviceToken === 'string') {
      section.serviceToken = a.serviceToken;
    }
    if (has(a, 'rateLimitPerMinute')) {
      section.rateLimitPerMinute = Math.round(
        number(a.rateLimitPerMinute, 'rateLimitPerMinute', 1, 600, 30)
      );
    }
    if (has(a, 'allowAdminSessionForApi')) {
      section.allowAdminSessionForApi = Boolean(a.allowAdminSessionForApi);
    }
    if (Object.keys(section).length) patch.api = section;
  }
  if (input.wechat && typeof input.wechat === 'object') {
    const w = input.wechat;
    const section = {};
    if (has(w, 'botToken') && typeof w.botToken === 'string') {
      section.botToken = w.botToken;
    }
    if (has(w, 'ilinkBotId')) section.ilinkBotId = text(w.ilinkBotId, 'ilink_bot_id', 120);
    if (has(w, 'ilinkUserId')) {
      section.ilinkUserId = text(w.ilinkUserId, 'ilink_user_id', 120);
    }
    if (has(w, 'baseUrl')) {
      section.baseUrl =
        url(w.baseUrl, '微信 iLink 基座地址') || 'https://ilinkai.weixin.qq.com';
    }
    if (has(w, 'channelVersion')) {
      section.channelVersion = text(w.channelVersion, 'channel_version', 20) || '2.0.0';
    }
    if (has(w, 'contextTokenTtlHours')) {
      section.contextTokenTtlHours = Math.round(
        number(w.contextTokenTtlHours, 'contextTokenTtlHours', 1, 720, 24)
      );
    }
    if (has(w, 'typingEnabled')) section.typingEnabled = Boolean(w.typingEnabled);
    if (has(w, 'pollTimeoutSeconds')) {
      section.pollTimeoutSeconds = Math.round(
        number(w.pollTimeoutSeconds, 'pollTimeoutSeconds', 5, 120, 35)
      );
    }
    if (has(w, 'cdnBaseUrl')) {
      section.cdnBaseUrl =
        url(w.cdnBaseUrl, 'CDN 地址') || 'https://novac2c.cdn.weixin.qq.com/c2c';
    }
    if (has(w, 'mediaAesMode')) section.mediaAesMode = 'AES-128-ECB';
    if (has(w, 'autoSend')) section.autoSend = Boolean(w.autoSend);
    if (Object.keys(section).length) patch.wechat = section;
  }
  return patch;
}

async function probeStorage(candidate, env) {
  const opened = openBusinessStore(candidate, env);
  const result = await opened.store.probe();
  return { ...result, mode: opened.mode, available: opened.available, binding: opened.bindingName || '' };
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(context) {
  try {
    await requireAdmin(context.request, context.env || {});
    const config = await loadConfig(context.env || {});
    const meta = config.__meta || {};
    return ok({
      config: clientConfig(config),
      required: requiredStatus(config, meta),
      storage: {
        mode: meta.configStoreMode,
        available: meta.configStoreAvailable,
      },
      master_key_source: meta.masterKeySource,
      security: config.security,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequestPut(context) {
  try {
    const env = context.env || {};
    const session = await requireAdmin(context.request, env);
    assertCsrf(context.request, session);
    const body = await readJson(context.request);
    const current = await loadConfig(env);
    const input = body.config && typeof body.config === 'object' ? body.config : body;

    if (input.security) delete input.security;
    const patch = buildPatch(input);
    if (body.clearSecrets && Array.isArray(body.clearSecrets)) {
      patch.clearSecrets = body.clearSecrets
        .filter((path) =>
          [
            'deepseek.apiKey',
            'storage.redisToken',
            'api.serviceToken',
            'wechat.botToken',
          ].includes(path)
        )
        .slice(0, 4);
    }

    let serviceTokenOnce = '';
    if (body.rotate_service_token === true) {
      serviceTokenOnce = randomHex(24);
      patch.api = { ...(patch.api || {}), serviceToken: serviceTokenOnce };
    }

    const candidate = deepMerge(clone(current), patch);
    if (candidate.storage.driver === 'redis') {
      if (!candidate.storage.redisUrl || !candidate.storage.redisToken) {
        throw new HttpError(
          400,
          'INVALID_CONFIG',
          'Redis 存储需要同时提供地址与访问令牌'
        );
      }
    }

    let probe = null;
    try {
      probe = await probeStorage(candidate, env);
    } catch (error) {
      if (candidate.storage.driver === 'redis') {
        throw new HttpError(400, 'STORAGE_PROBE_FAILED', `存储校验失败：${error.message}`);
      }
      probe = { ok: false, error: error.message, mode: candidate.storage.driver };
    }

    const saved = await saveConfig(env, patch);
    const meta = saved.__meta || {};
    return ok({
      config: clientConfig(saved),
      required: requiredStatus(saved, meta),
      storage_probe: probe,
      master_key_source: meta.masterKeySource,
      service_token_once: serviceTokenOnce,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'PUT') return onRequestPut(context);
  return handleError(new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET/PUT'));
}
