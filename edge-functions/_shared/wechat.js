import { HttpError } from './http.js';
import { sanitizePrefix } from './store.js';
import { b64urlEncode, randomBytes, sha256Hex, truncateText } from './util.js';

function prefix(config) {
  return sanitizePrefix(config.storage.keyPrefix, 'cb');
}

function ensureConfig(config) {
  const wechat = config.wechat || {};
  if (!wechat.botToken) {
    throw new HttpError(400, 'WECHAT_NOT_CONFIGURED', '尚未配置微信机器人 bot_token');
  }
  if (!wechat.baseUrl) {
    throw new HttpError(400, 'WECHAT_NOT_CONFIGURED', '尚未配置微信 iLink 基座地址');
  }
}

function randomUin() {
  const bytes = randomBytes(4);
  const value =
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  return b64urlEncode(String(value >>> 0));
}

async function wechatFetch(config, path, { method = 'POST', body = null, timeoutMs = 20000 } = {}) {
  ensureConfig(config);
  const wechat = config.wechat;
  const base = String(wechat.baseUrl).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${wechat.botToken}`,
        'X-WECHAT-UIN': randomUin(),
      },
      body: body
        ? JSON.stringify({
            ...body,
            base_info: { channel_version: wechat.channelVersion || '2.0.0' },
          })
        : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: truncateText(text, 300) };
    }
    if (!response.ok) {
      throw new HttpError(
        502,
        'WECHAT_UPSTREAM',
        `微信接口请求失败（HTTP ${response.status}）：${truncateText(
          payload.errmsg || payload.raw || '',
          160
        )}`
      );
    }
    if (payload.ret !== undefined && payload.ret !== 0) {
      throw new HttpError(
        502,
        'WECHAT_UPSTREAM',
        `微信接口返回错误 ret=${payload.ret}${payload.errmsg ? `：${payload.errmsg}` : ''}`
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.name === 'AbortError') {
      throw new HttpError(504, 'WECHAT_TIMEOUT', '微信接口请求超时');
    }
    throw new HttpError(502, 'WECHAT_NETWORK', `无法连接微信接口：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendWechatMessage(config, { toUserId, contextToken, text }) {
  if (!toUserId || !contextToken) {
    throw new HttpError(400, 'WECHAT_PARAMS', '发送消息需要 to_user_id 与 context_token');
  }
  return wechatFetch(config, '/sendmessage', {
    body: {
      msg: {
        to_user_id: toUserId,
        context_token: contextToken,
        text: String(text || ''),
      },
    },
  });
}

export async function getTypingTicket(config, { userId, contextToken }) {
  const payload = await wechatFetch(config, '/getconfig', {
    body: {
      ilink_user_id: userId,
      context_token: contextToken,
    },
  });
  return payload.typing_ticket || '';
}

export async function sendWechatTyping(config, { userId, typingTicket, status }) {
  return wechatFetch(config, '/sendtyping', {
    body: {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status: status ? 1 : 2,
    },
  });
}

async function contextKey(config, userId) {
  const hash = (await sha256Hex(userId)).slice(0, 24);
  return `${prefix(config)}_ctx_${hash}`;
}

export async function saveContextToken(store, config, userId, token) {
  if (!token) return null;
  const now = Date.now();
  const ttlHours = Math.max(1, Number(config.wechat.contextTokenTtlHours) || 24);
  const record = {
    userId,
    token: String(token),
    updatedAt: now,
    expiresAt: now + ttlHours * 3600000,
  };
  await store.putJson(await contextKey(config, userId), record);
  return record;
}

export async function getContextToken(store, config, userId) {
  const record = await store.getJson(await contextKey(config, userId));
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}

async function typingKey(config, userId) {
  const hash = (await sha256Hex(userId)).slice(0, 24);
  return `${prefix(config)}_typ_${hash}`;
}

export async function ensureTypingTicket(store, config, userId, contextToken) {
  const key = await typingKey(config, userId);
  const cached = await store.getJson(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ticket;
  const ticket = await getTypingTicket(config, {
    userId: config.wechat.ilinkUserId || userId,
    contextToken,
  });
  if (ticket) {
    await store.putJson(key, {
      ticket,
      updatedAt: Date.now(),
      expiresAt: Date.now() + 23 * 3600000,
    });
  }
  return ticket;
}

export async function testWechat(config, store) {
  const started = Date.now();
  const userId = config.wechat.ilinkUserId;
  if (userId) {
    const context = await getContextToken(store, config, userId);
    if (context?.token) {
      const ticket = await getTypingTicket(config, {
        userId,
        contextToken: context.token,
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: ticket ? '鉴权与 getconfig 正常' : '接口可达，但未返回 typing_ticket',
      };
    }
  }
  const payload = await wechatFetch(config, '/get_bot_qrcode?bot_type=3', {
    method: 'GET',
    timeoutMs: 15000,
  });
  return {
    ok: Boolean(payload.qrcode || payload.qrcode_img_content),
    latencyMs: Date.now() - started,
    message: 'iLink 接口可达（已获取登录二维码参数）',
  };
}
