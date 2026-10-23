import {
  assertCsrf,
  createSetupToken,
  getPasskeys,
  listSetupTokens,
  removePasskey,
  requireAdmin,
  resolveSecurity,
  revokeSetupToken,
} from '../../_shared/auth.js';
import { loadConfig } from '../../_shared/config.js';
import {
  HttpError,
  clientIp,
  handleError,
  ok,
  preflight,
  readJson,
  requestOrigin,
} from '../../_shared/http.js';
import { rateLimit } from '../../_shared/rate-limit.js';

function passkeyView(passkey) {
  return {
    id: passkey.id,
    label: passkey.label || '安全密钥',
    algorithm: passkey.algorithm,
    counter: passkey.counter || 0,
    transports: passkey.transports || [],
    created_at: passkey.createdAt,
    last_used_at: passkey.lastUsedAt || null,
    user_agent: passkey.userAgent || '',
  };
}

function linkView(record, origin) {
  return {
    token_id: record.hash,
    label: record.label,
    short_id: `${record.hash.slice(0, 8)}…`,
    created_at: record.createdAt,
    expires_at: new Date(record.expiresAt).toISOString(),
    created_by: record.createdBy || '',
    // 原始 token 只在创建时返回一次，列表中仅提供提示
    hint: origin ? `${origin}/setup?token=…` : '/setup?token=…',
  };
}

function resolveBaseUrl(request, config, env, candidate) {
  const raw = String(
    candidate || env.PUBLIC_ORIGIN || config.security.publicOrigin || requestOrigin(request)
  ).replace(/\/$/, '');
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('protocol');
    return parsed.origin;
  } catch {
    throw new HttpError(400, 'INVALID_BASE_URL', '配置链接的访问地址不合法');
  }
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(context) {
  try {
    const env = context.env || {};
    await requireAdmin(context.request, env);
    const config = await loadConfig(env);
    const security = resolveSecurity(context.request, config, env);
    const passkeys = await getPasskeys(env);
    const links = await listSetupTokens(env);
    return ok({
      rp_id: security.rpId,
      public_origin: security.origin,
      passkeys: passkeys.map(passkeyView),
      passkey_limit: 20,
      setup_links: links.map((record) => linkView(record, security.origin)),
      bootstrap_env_configured: Boolean(env.BOOTSTRAP_TOKEN),
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequestPost(context) {
  try {
    const env = context.env || {};
    const request = context.request;
    const session = await requireAdmin(request, env);
    assertCsrf(request, session);
    const body = await readJson(request);
    const action = String(body.action || '');

    if (action === 'create_setup_link') {
      await rateLimit(env, {
        bucket: 'setup_link',
        key: clientIp(request),
        limit: 10,
        windowSeconds: 600,
      });
      const config = await loadConfig(env);
      const origin = resolveBaseUrl(request, config, env, body.base_url);
      const record = await createSetupToken(env, {
        label: body.label || '配置链接',
        ttlMinutes: body.ttl_minutes,
        createdBy: session.pk || 'admin',
      });
      return ok({
        token: record.token,
        token_id: record.hash,
        url: `${origin}/setup?token=${record.token}`,
        label: record.label,
        expires_at: new Date(record.expiresAt).toISOString(),
        note: '该链接仅供一次性使用，完成安全密钥注册后立即失效；请通过安全渠道发送。',
      });
    }

    if (action === 'revoke_setup_link') {
      const tokenId = String(body.token_id || body.hash || '');
      await revokeSetupToken(env, tokenId);
      return ok({ revoked: true, token_id: tokenId });
    }

    if (action === 'delete_passkey') {
      const id = String(body.id || body.passkey_id || '').trim();
      if (!id) throw new HttpError(400, 'PASSKEY_ID_REQUIRED', '缺少安全密钥 ID');
      if (session.pk === id) {
        throw new HttpError(400, 'CURRENT_PASSKEY', '不能删除当前正在使用的安全密钥');
      }
      const next = await removePasskey(env, id);
      return ok({ deleted: true, passkeys: next.map(passkeyView) });
    }

    throw new HttpError(400, 'UNKNOWN_ACTION', `未知操作：${action}`);
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return handleError(new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET/POST'));
}
