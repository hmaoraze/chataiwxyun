import { loadApiContext } from '../_shared/api-auth.js';
import {
  HttpError,
  corsHeaders,
  handleError,
  ok,
  preflight,
  readJson,
  sseResponse,
  sseWriter,
} from '../_shared/http.js';
import { rateLimit } from '../_shared/rate-limit.js';
import {
  createSession,
  endSession,
  getSession,
  getSessionDetail,
  handleMessage,
  listSessions,
} from '../_shared/session.js';
import { normalizeUserId } from '../_shared/util.js';

function requireUserId(value, label = 'user_id') {
  const userId = normalizeUserId(value);
  if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', `缺少 ${label}`);
  return userId;
}

async function resolveSessionUser(ctx, body) {
  const provided = normalizeUserId(body.user_id);
  if (!body.session_id) {
    return requireUserId(provided);
  }
  const meta = await getSession(ctx.store, ctx.config, body.session_id);
  if (!meta) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  if (provided && provided !== meta.userId) {
    throw new HttpError(403, 'SESSION_FORBIDDEN', '会话不属于该用户');
  }
  return meta.userId;
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost(context) {
  try {
    const ctx = await loadApiContext(context);
    const body = await readJson(context.request);
    const action = String(body.action || 'message');

    if (action === 'create') {
      const userId = requireUserId(body.user_id);
      await rateLimit(context.env, {
        bucket: 'session',
        key: userId,
        limit: Number(ctx.config.api.rateLimitPerMinute) || 30,
      });
      const session = await createSession(ctx.store, ctx.config, userId, {
        title: normalizeUserId(body.title),
        metadata:
          body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
      });
      return ok({ session }, corsHeaders());
    }

    if (action === 'message') {
      const userId = await resolveSessionUser(ctx, body);
      await rateLimit(context.env, {
        bucket: 'session',
        key: userId,
        limit: Number(ctx.config.api.rateLimitPerMinute) || 30,
      });
      const content = String(body.content || '').trim();
      if (!content) throw new HttpError(400, 'EMPTY_MESSAGE', '缺少 content');

      if (body.stream === true) {
        const sse = sseWriter();
        (async () => {
          try {
            await sse.send('start', { session_id: body.session_id || null });
            const result = await handleMessage(ctx.store, ctx.config, userId, {
              sessionId: body.session_id,
              content,
              stream: true,
              client: 'stream',
              onDelta: (delta) => sse.send('delta', { content: delta }),
            });
            for (const memory of result.memories) {
              await sse.send('memory', memory);
            }
            await sse.send('done', {
              session_id: result.session.session_id,
              session: result.session,
              reply: result.reply,
              usage: result.usage,
              memories_saved: result.memoriesSaved,
              renewed: result.renewed,
              finalized: result.finalized,
            });
          } catch (error) {
            await sse.send('error', {
              code: error?.code || 'INTERNAL_ERROR',
              message: error?.message || '生成回复失败',
            });
          } finally {
            await sse.close();
          }
        })();
        return sseResponse(sse.readable, corsHeaders());
      }

      const result = await handleMessage(ctx.store, ctx.config, userId, {
        sessionId: body.session_id,
        content,
        stream: false,
        client: String(body.client || 'api'),
      });
      return ok(
        {
          session_id: result.session.session_id,
          session: result.session,
          reply: result.reply,
          usage: result.usage,
          memories_saved: result.memoriesSaved,
          memories: result.memories,
          renewed: result.renewed,
          finalized: result.finalized,
        },
        corsHeaders()
      );
    }

    if (action === 'end') {
      const userId = await resolveSessionUser(ctx, body);
      if (!body.session_id) throw new HttpError(400, 'SESSION_ID_REQUIRED', '缺少 session_id');
      const result = await endSession(ctx.store, ctx.config, userId, body.session_id, {
        extract: body.extract !== false,
      });
      return ok(
        {
          session: result.session,
          memories_saved: result.memoriesSaved || 0,
          extraction_status: result.extractionStatus || '',
          already_ended: Boolean(result.skipped),
        },
        corsHeaders()
      );
    }

    if (action === 'get') {
      const userId = await resolveSessionUser(ctx, body);
      if (!body.session_id) throw new HttpError(400, 'SESSION_ID_REQUIRED', '缺少 session_id');
      const detail = await getSessionDetail(
        ctx.store,
        ctx.config,
        ctx.auth.kind === 'admin' && !body.user_id ? '' : userId,
        body.session_id
      );
      return ok(detail, corsHeaders());
    }

    if (action === 'list') {
      if (ctx.auth.kind !== 'admin' && !body.user_id) {
        throw new HttpError(400, 'USER_ID_REQUIRED', '服务令牌调用 list 时必须提供 user_id');
      }
      const sessions = await listSessions(
        ctx.store,
        ctx.config,
        normalizeUserId(body.user_id),
        Number(body.limit) || 50
      );
      return ok({ sessions }, corsHeaders());
    }

    throw new HttpError(400, 'UNKNOWN_ACTION', `未知操作：${action}`);
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'POST') return onRequestPost(context);
  return handleError(
    new HttpError(405, 'METHOD_NOT_ALLOWED', '会话接口仅支持 POST'),
    corsHeaders()
  );
}
