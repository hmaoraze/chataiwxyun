import { loadApiContext } from '../../_shared/api-auth.js';
import {
  HttpError,
  corsHeaders,
  handleError,
  ok,
  preflight,
  readJson,
} from '../../_shared/http.js';
import { normalizeUserId } from '../../_shared/util.js';
import { getContextToken, saveContextToken } from '../../_shared/wechat.js';

function tokenView(record) {
  if (!record) return null;
  return {
    user_id: record.userId,
    context_token: record.token,
    updated_at: record.updatedAt,
    expires_at: record.expiresAt,
  };
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(context) {
  try {
    const ctx = await loadApiContext(context);
    const url = new URL(context.request.url);
    const userId = normalizeUserId(url.searchParams.get('user_id'));
    if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', '缺少 user_id');
    const record = await getContextToken(ctx.store, ctx.config, userId);
    return ok({ found: Boolean(record), ...tokenView(record) }, corsHeaders());
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequestPost(context) {
  try {
    const ctx = await loadApiContext(context);
    const body = await readJson(context.request);
    const action = String(body.action || 'save');
    const userId = normalizeUserId(body.user_id || body.ilink_user_id);
    if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', '缺少 user_id');

    if (action === 'save') {
      const token = String(body.context_token || '').trim();
      if (!token) throw new HttpError(400, 'CONTEXT_TOKEN_REQUIRED', '缺少 context_token');
      const record = await saveContextToken(ctx.store, ctx.config, userId, token);
      return ok({ saved: true, ...tokenView(record) }, corsHeaders());
    }

    if (action === 'get') {
      const record = await getContextToken(ctx.store, ctx.config, userId);
      return ok({ found: Boolean(record), ...tokenView(record) }, corsHeaders());
    }

    throw new HttpError(400, 'UNKNOWN_ACTION', `未知操作：${action}`);
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return handleError(
    new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET/POST'),
    corsHeaders()
  );
}
