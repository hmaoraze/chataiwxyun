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
import { getContextToken, sendWechatMessage } from '../../_shared/wechat.js';

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost(context) {
  try {
    const ctx = await loadApiContext(context);
    const body = await readJson(context.request);
    const userId = normalizeUserId(body.to_user_id || body.user_id);
    if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', '缺少 to_user_id');
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(400, 'EMPTY_MESSAGE', '消息内容不能为空');

    let contextToken = String(body.context_token || '').trim();
    if (!contextToken) {
      const stored = await getContextToken(ctx.store, ctx.config, userId);
      contextToken = stored?.token || '';
    }
    if (!contextToken) {
      throw new HttpError(
        400,
        'CONTEXT_TOKEN_REQUIRED',
        '该用户没有可用的 context_token，请先通过 /api/wechat/context 保存'
      );
    }

    const payload = await sendWechatMessage(ctx.config, {
      toUserId: userId,
      contextToken,
      text,
    });
    return ok({ sent: true, to_user_id: userId, upstream: payload }, corsHeaders());
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'POST') return onRequestPost(context);
  return handleError(
    new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST'),
    corsHeaders()
  );
}
