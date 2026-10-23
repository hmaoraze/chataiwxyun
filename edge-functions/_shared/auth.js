import { PASSKEY_KEY } from './constants.js';
import { getMasterKey } from './config.js';
import { sealJson, unsealJson } from './crypto.js';
import {
  HttpError,
  buildCookie,
  clearCookie,
  getCookie,
  isHttps,
  requestOrigin,
} from './http.js';
import { openConfigStore, listAll } from './store.js';
import {
  b64urlDecode,
  b64urlEncode,
  constantTimeEqual,
  randomHex,
  randomId,
  sha256Hex,
} from './util.js';

export const COOKIE_ADMIN = 'cb_admin';
export const COOKIE_CSRF = 'cb_csrf';
export const COOKIE_SETUP = 'cb_setup';
export const COOKIE_CHALLENGE = 'cb_chal';

const ADMIN_TTL_SECONDS = 12 * 60 * 60;
const SETUP_TTL_SECONDS = 15 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;

function cookieOptions(request, maxAge, httpOnly = true) {
  return {
    maxAge,
    httpOnly,
    secure: isHttps(request),
    sameSite: 'Lax',
    path: '/',
  };
}

export async function adminSessionFromRequest(request, env) {
  const token = getCookie(request, COOKIE_ADMIN);
  if (!token) return null;
  const master = await getMasterKey(env);
  const payload = await unsealJson(token, master.secret);
  if (!payload || payload.typ !== 'admin') return null;
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

export async function requireAdmin(request, env) {
  const session = await adminSessionFromRequest(request, env);
  if (!session) {
    throw new HttpError(401, 'UNAUTHORIZED', '请先使用安全密钥登录');
  }
  return session;
}

export async function createAdminSession(request, headers, passkeyId = '', env = {}) {
  const payload = {
    typ: 'admin',
    sid: randomId(10),
    csrf: randomHex(16),
    pk: passkeyId,
    iat: Date.now(),
    exp: Date.now() + ADMIN_TTL_SECONDS * 1000,
  };
  const master = await getMasterKey(env);
  const token = await sealJson(payload, master.secret);
  headers.append(
    'Set-Cookie',
    buildCookie(COOKIE_ADMIN, token, cookieOptions(request, ADMIN_TTL_SECONDS, true))
  );
  // 双提交 CSRF：前端读取该 Cookie 并放入请求头
  headers.append(
    'Set-Cookie',
    buildCookie(COOKIE_CSRF, payload.csrf, cookieOptions(request, ADMIN_TTL_SECONDS, false))
  );
  return payload;
}

export function clearAdminCookies(headers) {
  headers.append('Set-Cookie', clearCookie(COOKIE_ADMIN));
  headers.append('Set-Cookie', clearCookie(COOKIE_CSRF));
  headers.append('Set-Cookie', clearCookie(COOKIE_SETUP));
  headers.append('Set-Cookie', clearCookie(COOKIE_CHALLENGE));
}

export function assertCsrf(request, session) {
  const header = request.headers.get('x-csrf-token') || '';
  const cookie = getCookie(request, COOKIE_CSRF);
  if (!header || !cookie || !session?.csrf) {
    throw new HttpError(403, 'CSRF_REQUIRED', '缺少 CSRF 校验信息');
  }
  if (!constantTimeEqual(header, session.csrf) || !constantTimeEqual(cookie, session.csrf)) {
    throw new HttpError(403, 'CSRF_INVALID', 'CSRF 校验失败');
  }
}

export async function getPasskeys(env) {
  const { store } = openConfigStore(env);
  const raw = await store.get(PASSKEY_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function savePasskeys(env, passkeys) {
  const { store } = openConfigStore(env);
  await store.put(PASSKEY_KEY, JSON.stringify(passkeys.slice(0, 20)));
}

export async function addPasskey(env, passkey) {
  const passkeys = await getPasskeys(env);
  if (passkeys.some((item) => item.id === passkey.id)) {
    throw new HttpError(409, 'PASSKEY_EXISTS', '该安全密钥已经注册');
  }
  if (passkeys.length >= 20) {
    throw new HttpError(400, 'PASSKEY_LIMIT', '最多支持 20 个安全密钥');
  }
  const next = [...passkeys, passkey];
  await savePasskeys(env, next);
  return next;
}

export async function touchPasskey(env, id, counter) {
  const passkeys = await getPasskeys(env);
  const index = passkeys.findIndex((item) => item.id === id);
  if (index < 0) return null;
  passkeys[index] = {
    ...passkeys[index],
    counter,
    lastUsedAt: new Date().toISOString(),
  };
  await savePasskeys(env, passkeys);
  return passkeys[index];
}

export async function removePasskey(env, id) {
  const passkeys = await getPasskeys(env);
  if (passkeys.length <= 1) {
    throw new HttpError(400, 'LAST_PASSKEY', '至少需要保留一个安全密钥');
  }
  const next = passkeys.filter((item) => item.id !== id);
  if (next.length === passkeys.length) {
    throw new HttpError(404, 'PASSKEY_NOT_FOUND', '安全密钥不存在');
  }
  await savePasskeys(env, next);
  return next;
}

export async function createSetupToken(env, { label = '', ttlMinutes = 30, createdBy = '' } = {}) {
  const token = randomHex(24);
  const hash = await sha256Hex(token);
  const minutes = Math.max(5, Math.min(Number(ttlMinutes) || 30, 24 * 60));
  const now = Date.now();
  const record = {
    hash,
    label: String(label || '配置链接').slice(0, 60),
    createdAt: new Date(now).toISOString(),
    expiresAt: now + minutes * 60000,
    createdBy,
  };
  const { store } = openConfigStore(env);
  await store.put(`cb_setup_${hash}`, JSON.stringify(record));
  return { token, ...record };
}

export async function listSetupTokens(env) {
  const { store } = openConfigStore(env);
  const keys = await listAll(store, 'cb_setup_', 200);
  const now = Date.now();
  const records = [];
  for (const key of keys) {
    const raw = await store.get(key);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      if (record.expiresAt > now) records.push(record);
    } catch {
      /* 忽略损坏记录 */
    }
  }
  return records.sort((a, b) => b.expiresAt - a.expiresAt);
}

export async function revokeSetupToken(env, hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash || ''))) {
    throw new HttpError(400, 'INVALID_TOKEN_ID', '链接标识不合法');
  }
  const { store } = openConfigStore(env);
  await store.delete(`cb_setup_${hash}`);
}

export async function validateSetupToken(env, token) {
  const value = String(token || '').trim();
  if (!value) return null;
  const hash = await sha256Hex(value);
  const { store } = openConfigStore(env);
  const raw = await store.get(`cb_setup_${hash}`);
  if (raw) {
    try {
      const record = JSON.parse(raw);
      if (record.expiresAt > Date.now()) {
        return { kind: 'generated', hash, label: record.label || '' };
      }
    } catch {
      /* 继续检查环境变量令牌 */
    }
  }
  if (env.BOOTSTRAP_TOKEN && constantTimeEqual(value, String(env.BOOTSTRAP_TOKEN))) {
    const used = await store.get(`cb_boot_${hash}`);
    if (!used) return { kind: 'env', hash, label: '环境变量引导令牌' };
  }
  return null;
}

export async function consumeSetupToken(env, info) {
  if (!info) return;
  const { store } = openConfigStore(env);
  if (info.kind === 'generated') {
    await store.delete(`cb_setup_${info.hash}`);
  } else {
    await store.put(`cb_boot_${info.hash}`, new Date().toISOString());
  }
}

export async function sealSetupSession(request, headers, payload, env = {}) {
  const master = await getMasterKey(env);
  const token = await sealJson(
    { ...payload, typ: 'setup', exp: Date.now() + SETUP_TTL_SECONDS * 1000 },
    master.secret
  );
  headers.append(
    'Set-Cookie',
    buildCookie(COOKIE_SETUP, token, cookieOptions(request, SETUP_TTL_SECONDS, true))
  );
}

export async function readSetupSession(request, env) {
  const token = getCookie(request, COOKIE_SETUP);
  if (!token) return null;
  const master = await getMasterKey(env);
  const payload = await unsealJson(token, master.secret);
  if (!payload || payload.typ !== 'setup' || payload.exp < Date.now()) return null;
  return payload;
}

export async function clearSetupSession(headers) {
  headers.append('Set-Cookie', clearCookie(COOKIE_SETUP));
}

export async function sealChallenge(request, headers, payload, env = {}) {
  const master = await getMasterKey(env);
  const token = await sealJson(
    { ...payload, typ: 'challenge', exp: Date.now() + CHALLENGE_TTL_SECONDS * 1000 },
    master.secret
  );
  headers.append(
    'Set-Cookie',
    buildCookie(COOKIE_CHALLENGE, token, cookieOptions(request, CHALLENGE_TTL_SECONDS, true))
  );
}

export async function readChallenge(request, env) {
  const token = getCookie(request, COOKIE_CHALLENGE);
  if (!token) return null;
  const master = await getMasterKey(env);
  const payload = await unsealJson(token, master.secret);
  if (!payload || payload.typ !== 'challenge' || payload.exp < Date.now()) return null;
  return payload;
}

export function clearChallenge(headers) {
  headers.append('Set-Cookie', clearCookie(COOKIE_CHALLENGE));
}

export function resolveSecurity(request, config, env) {
  const origin = String(
    env.PUBLIC_ORIGIN || config.security.publicOrigin || requestOrigin(request)
  ).replace(/\/$/, '');
  const rpId = String(env.RP_ID || config.security.rpId || new URL(origin).hostname);
  return { origin, rpId };
}

export function decodeCredentialId(value) {
  return b64urlDecode(value);
}

export function encodeCredentialId(value) {
  return b64urlEncode(value);
}
