import { loadApiContext } from '../../_shared/api-auth.js';
import {
  HttpError,
  corsHeaders,
  handleError,
  ok,
  preflight,
  readJson,
} from '../../_shared/http.js';
import { rateLimit } from '../../_shared/rate-limit.js';
import {
  getActiveSessionId,
  handleMessage,
} from '../../_shared/session.js';
import { sanitizePrefix } from '../../_shared/store.js';
import { normalizeUserId, sha256Hex, truncateText } from '../../_shared/util.js';
import {
  ensureTypingTicket,
  getContextToken,
  saveContextToken,
  sendWechatMessage,
  sendWechatTyping,
} from '../../_shared/wechat.js';

function extractText(body) {
  const candidates = [body.text, body.content, body.message?.text, body.msg?.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

async function seenMessage(store, config, userId, msgId) {
  if (!msgId) return false;
  const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
  const hash = (await sha256Hex(`${userId}:${msgId}`)).slice(0, 24);
  return Boolean(await store.getJson(`${prefix}_msgid_${hash}`));
}

async function markMessage(store, config, userId, msgId) {
  if (!msgId) return;
  const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
  const hash = (await sha256Hex(`${userId}:${msgId}`)).slice(0, 24);
  await store.putJson(`${prefix}_msgid_${hash}`, {
    userId,
    msgId: truncateText(msgId, 120),
    createdAt: Date.now(),
  });
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost(context) {
  try {
    const ctx = await loadApiContext(context, { requireServiceToken: false });
    const body = await readJson(context.request);
    const userId = normalizeUserId(
      body.user_id || body.from_user_id || body.ilink_user_id
    );
    if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', '缺少 from_user_id');
    const text = extractText(body);
    if (!text) throw new HttpError(400, 'EMPTY_MESSAGE', '仅支持非空文本消息');

    await rateLimit(context.env, {
      bucket: 'wechat',
      key: userId,
      limit: Math.max(Number(ctx.config.api.rateLimitPerMinute) || 30, 60),
    });

    const msgId = String(body.msg_id || body.message_id || '').trim();
    if (await seenMessage(ctx.store, ctx.config, userId, msgId)) {
      return ok({ duplicate: true, msg_id: msgId, session_id: body.session_id || null });
    }

    const contextToken = String(
      body.context_token || body.contextToken || ''
    ).trim();
    if (contextToken) {
      await saveContextToken(ctx.store, ctx.config, userId, contextToken);
    }
    const storedContext = contextToken
      ? { token: contextToken }
      : await getContextToken(ctx.store, ctx.config, userId);

    const typingEnabled =
      ctx.config.wechat.typingEnabled !== false && body.send_typing !== false;
    let typingTicket = '';
    if (typingEnabled && storedContext?.token) {
      try {
        typingTicket = await ensureTypingTicket(
          ctx.store,
          ctx.config,
          userId,
          storedContext.token
        );
        if (typingTicket) {
          await sendWechatTyping(ctx.config, {
            userId: ctx.config.wechat.ilinkUserId || userId,
            typingTicket,
            status: true,
          });
        }
      } catch (error) {
        console.warn('[wechat] 启动输入状态失败', error.message);
      }
    }

    let sessionId = String(body.session_id || '').trim();
    if (!sessionId) {
      sessionId = (await getActiveSessionId(ctx.store, ctx.config, userId)) || '';
    }

    let result;
    try {
      result = await handleMessage(ctx.store, ctx.config, userId, {
        sessionId: sessionId || undefined,
        content: text,
        stream: false,
        client: 'wechat',
      });
    } finally {
      if (typingTicket) {
        await sendWechatTyping(ctx.config, {
          userId: ctx.config.wechat.ilinkUserId || userId,
          typingTicket,
          status: false,
        }).catch(() => {});
      }
    }

    await markMessage(ctx.store, ctx.config, userId, msgId);

    const autoSend = body.auto_send === true || ctx.config.wechat.autoSend === true;
    let sent = false;
    let sendError = '';
    if (autoSend && body.skip_send !== true) {
      if (!storedContext?.token) {
        sendError = '缺少 context_token，无法主动发送消息';
      } else {
        try {
          await sendWechatMessage(ctx.config, {
            toUserId: userId,
            contextToken: storedContext.token,
            text: result.reply,
          });
          sent = true;
        } catch (error) {
          sendError = error.message;
        }
      }
    }

    return ok(
      {
        duplicate: false,
        msg_id: msgId,
        user_id: userId,
        session_id: result.session.session_id,
        session: result.session,
        reply: result.reply,
        usage: result.usage,
        memories_saved: result.memoriesSaved,
        memories: result.memories,
        renewed: result.renewed,
        finalized: result.finalized,
        sent,
        send_error: sendError,
        typing: Boolean(typingTicket),
      },
      corsHeaders()
    );
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'POST') return onRequestPost(context);
  return handleError(
    new HttpError(405, 'METHOD_NOT_ALLOWED', '微信消息接口仅支持 POST'),
    corsHeaders()
  );
}
