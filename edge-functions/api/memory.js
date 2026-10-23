import { loadApiContext } from '../_shared/api-auth.js';
import {
  HttpError,
  corsHeaders,
  handleError,
  ok,
  preflight,
  readJson,
} from '../_shared/http.js';
import {
  deleteMemory,
  loadMemories,
  memoryView,
  saveMemory,
  scoreMemory,
} from '../_shared/memory.js';
import { normalizeUserId, truncateText } from '../_shared/util.js';

function requiredUserId(value) {
  const id = normalizeUserId(value);
  if (!id) throw new HttpError(400, 'USER_ID_REQUIRED', '缺少 user_id');
  return id;
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(context) {
  try {
    const ctx = await loadApiContext(context);
    const url = new URL(context.request.url);
    const userId = requiredUserId(url.searchParams.get('user_id'));
    const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 300));
    const includeExpired =
      ctx.auth.kind === 'admin' && url.searchParams.get('include_expired') === 'true';

    const all = await loadMemories(ctx.store, ctx.config, userId, { includeExpired });
    const filtered = query
      ? all.filter((memory) => String(memory.content).toLowerCase().includes(query))
      : all;
    const now = Date.now();
    const memories = filtered.slice(0, limit).map((memory) => ({
      ...memoryView(memory),
      score: Math.round(scoreMemory(memory, now) * 100) / 100,
    }));
    return ok(
      {
        user_id: userId,
        total: filtered.length,
        memories,
      },
      corsHeaders()
    );
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequestPost(context) {
  try {
    const ctx = await loadApiContext(context);
    const body = await readJson(context.request);
    const userId = requiredUserId(body.user_id);
    const result = await saveMemory(ctx.store, ctx.config, userId, {
      content: truncateText(body.content, 500),
      kind: body.kind,
      importance: body.importance,
      tags: body.tags,
      source: 'manual',
    });
    return ok(
      {
        memory: memoryView(result.memory),
        action: result.action,
      },
      corsHeaders()
    );
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequestDelete(context) {
  try {
    const ctx = await loadApiContext(context);
    const url = new URL(context.request.url);
    let userId = url.searchParams.get('user_id');
    let id = url.searchParams.get('id');
    if (!userId || !id) {
      const body = await readJson(context.request).catch(() => ({}));
      userId = userId || body.user_id;
      id = id || body.id;
    }
    const resolvedUser = requiredUserId(userId);
    if (!id) throw new HttpError(400, 'MEMORY_ID_REQUIRED', '缺少记忆 id');
    await deleteMemory(ctx.store, ctx.config, resolvedUser, id);
    return ok({ deleted: true, id }, corsHeaders());
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  return handleError(
    new HttpError(405, 'METHOD_NOT_ALLOWED', '记忆接口仅支持 GET/POST/DELETE'),
    corsHeaders()
  );
}
