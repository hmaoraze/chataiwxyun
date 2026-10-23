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
import {
  ensureTypingTicket,
  getContextToken,
  sendWechatTyping,
} from '../../_shared/wechat.js';

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost(context) {
  try {
    const ctx = await loadApiContext(context);
    const body = await readJson(context.request);
    const userId = normalizeUserId(body.user_id || body.ilink_user_id);
    if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', '缺少 user_id');

    if (ctx.config.wechat.typingEnabled === false) {
      return ok({ sent: false, skipped: true, reason: '配置中已关闭输入状态' }, corsHeaders());
    }

    let contextToken = String(body.context_token || '').trim();
    if (!contextToken) {
      const stored = await getContextToken(ctx.store, ctx.config, userId);
      contextToken = stored?.token || '';
    }
    if (!contextToken) {
      throw new HttpError(
        400,
        'CONTEXT_TOKEN_REQUIRED',
        '缺少 context_token，无法获取 typing_ticket'
      );
    }

    const ticket = await ensureTypingTicket(ctx.store, ctx.config, userId, contextToken);
    if (!ticket) {
      return ok({ sent: false, reason: 'getconfig 未返回 typing_ticket' }, corsHeaders());
    }
    const status = body.status !== false;
    await sendWechatTyping(ctx.config, {
      userId: ctx.config.wechat.ilinkUserId || userId,
      typingTicket: ticket,
      status,
    });
    return ok({ sent: true, status }, corsHeaders());
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
